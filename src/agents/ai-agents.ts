/**
 * ============================================================
 * FILE: src/agents/ai-agents.ts
 * PURPOSE: AI-powered multi-agent pipeline.
 *          Runs 9 specialized AI agents in parallel, each with a focused
 *          system prompt, to produce a comprehensive PR review.
 *
 * WHY MULTI-AGENT?
 *   A single "review everything" prompt produces weaker results because
 *   the model spreads attention across security, bugs, types, style, etc.
 *   Specialized agents with narrow, focused prompts find more issues:
 *     - Security agent only thinks about vulnerabilities — no distraction
 *     - Bug agent only thinks about runtime correctness
 *     - ESLint agent only checks lint rules
 *   Running them in parallel (Promise.all) adds no latency over a single call.
 *
 * AGENTS (9 specialized):
 *   security       — XSS, secrets, injection, open redirects (confidence: 0.88)
 *   bug            — null deref, unhandled async, race conditions (confidence: 0.85)
 *   logic          — loose equality, wrong conditions, state sync (confidence: 0.82)
 *   types          — any usage, missing types, unsafe assertions (confidence: 0.80)
 *   eslint         — console statements, unused vars, hook deps (confidence: 0.78)
 *   performance    — expensive renders, missing useMemo (confidence: 0.81)
 *   best-practices — hardcoded values, missing error handling (confidence: 0.77)
 *   quality        — component structure, side effects in render (confidence: 0.75)
 *   fix            — auto-generated patches (not a review agent, just counting)
 *
 * FALLBACK:
 *   If ALL agents return zero findings across all files →
 *   runs local pattern agents (runLocalAgentPipeline) as a safety net.
 *   This ensures the review always returns something meaningful.
 *
 * AI BACKEND:
 *   Each agent calls callAI() from utils/ai-call.ts.
 *   callAI() auto-selects: Claude → Groq → Gemini → Ollama → null
 *   If null (no AI), agents return [] and the local fallback kicks in.
 * ============================================================
 */

import type {
  AgentName,
  AgentRunSummary,
  Patch,
  PRComment,
  ReviewFileResult,
  ReviewIssue,
  ReviewResult,
  SecurityIssue,
  Severity,
  TriagedFile
} from "../types.js";
import { createEmptyReview, finalizeSummary } from "../core/schema.js";
import { callAI } from "../utils/ai-call.js";
import { runLocalAgentPipeline } from "./local-agents.js";
import { safeJsonParse } from "../utils/json.js";

// ─── Internal Response Types ─────────────────────────────────────────────────

/**
 * Shape of a single issue as returned by each AI agent.
 * AI agents return this simpler format — we normalize it into ReviewIssue/SecurityIssue
 * after filtering and validation.
 */
interface AIReviewIssue {
  line: number;
  title: string;
  message: string;
  severity: Severity;
  code_snippet: string;
  suggestion?: string;  // Plain-text advice (less specific than fix)
  fix?: string;         // Concrete code fix
}

/**
 * The JSON response expected from each AI agent.
 * The AI is instructed to return ONLY this JSON structure — no prose.
 */
interface AIAgentResponse {
  issues: AIReviewIssue[];
}

// ─── Agent Spec Definition ────────────────────────────────────────────────────

/**
 * Configuration for a single specialized agent.
 * Each agent has its own:
 *   - system prompt (persona and what to look for)
 *   - maxTokens (budget for its response)
 *   - confidence (score assigned to all findings from this agent)
 *   - category (how its findings are classified in the report)
 */
interface AgentSpec {
  agent: Exclude<AgentName, "fix">;              // Agent identifier (not "fix" — that's synthetic)
  category: "security" | "bug" | "performance" | "quality"; // Finding category
  system: string;                                // System prompt with persona + instructions
  maxTokens: number;                             // Max response tokens for this agent
  confidence: number;                            // Confidence score for all this agent's findings
  label: string;                                 // Label added to each finding from this agent
}

// ─── Issue Routing Helpers ────────────────────────────────────────────────────

/**
 * Normalizes text for pattern matching.
 * Lowercases and strips non-alphanumeric characters.
 */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Returns normalized text combining all relevant fields of an AI issue.
 * Used to match the issue against agent-specific keyword patterns.
 */
function issueText(issue: AIReviewIssue): string {
  return normalizeText(`${issue.title} ${issue.message} ${issue.code_snippet} ${issue.suggestion ?? ""} ${issue.fix ?? ""}`);
}

/**
 * Returns true if any of the patterns appear in the text.
 * Used to check if an issue's text contains keywords for a specific agent.
 */
function hasAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

/**
 * Checks whether an AI-generated issue belongs to a specific agent's scope.
 * This is needed because AI models sometimes report issues that don't fit
 * the agent's focus (e.g., security agent reporting a lint issue).
 *
 * Each agent has a list of topic keywords. Issues are routed to the agent
 * if their combined text contains any of those keywords AND doesn't match
 * a higher-priority agent (security always wins overlap).
 *
 * @param agent - The agent to check relevance for
 * @param issue - The AI-generated issue to check
 * @returns true if the issue belongs to this agent's scope
 */
function issueBelongsToAgent(agent: Exclude<AgentName, "fix">, issue: AIReviewIssue): boolean {
  const text = issueText(issue);

  // ── Keyword lists per agent ───────────────────────────────────────────────
  // Security-related keywords — security agent has priority over all others
  const securityPatterns = [
    "secret", "api key", "token", "password", "xss", "dangerouslysetinnerhtml", "redirect",
    "javascript", "injection", "sanitize", "unsafe url", "script src", "img src", "console log secret"
  ];
  // Runtime bug keywords — actual crashes, data loss, incorrect behavior
  const bugPatterns = [
    "null", "undefined", "promise", "unhandled", "race condition", "memory leak", "infinite loop",
    "freeze", "crash", "async misuse", "unreachable", "dead code"
  ];
  // Logic error keywords — wrong conditions, state inconsistency
  const logicPatterns = [
    "wrong condition", "loose equality", "==", "mutation", "incorrect calculation", "incorrect transformation",
    "inconsistent", "invalid assumption", "edge case", "business logic"
  ];
  // Performance-related keywords
  const performancePatterns = [
    "performance", "expensive", "memo", "usememo", "usecallback", "re render", "rerender",
    "math random", "date now", "blocking", "large loop", "heavy computation", "duplicate expensive"
  ];
  // Lint/style keywords
  const eslintPatterns = [
    "unused", "console", "inline function", "formatting", "naming", "hook dependency", "loose equality", "style"
  ];
  // TypeScript type safety keywords
  const typePatterns = [
    "any", "type", "interface", "props", "state", "optional chaining", "type assertion", "typed", "typescript"
  ];
  // Engineering best practice keywords
  const bestPracticePatterns = [
    "hardcoded", "separation of concerns", "error handling", "direct dom", "reusability", "component structure"
  ];
  // Code quality and React-specific keywords
  const qualityPatterns = [
    "key prop", "hydration", "side effect", "link usage", "loading state", "error state", "bundle size",
    "extract component", "duplicate code", "readability", "maintainability", "large component", "nested condition"
  ];

  // Route issues to agents — security always gets priority (no other agent overrides it)
  if (agent === "security") return hasAny(text, securityPatterns);
  if (agent === "bug") return hasAny(text, bugPatterns) && !hasAny(text, securityPatterns);
  if (agent === "logic") return hasAny(text, logicPatterns) && !hasAny(text, securityPatterns);
  if (agent === "performance") return hasAny(text, performancePatterns) && !hasAny(text, securityPatterns);
  if (agent === "eslint") return hasAny(text, eslintPatterns) && !hasAny(text, securityPatterns);
  if (agent === "types") return hasAny(text, typePatterns) && !hasAny(text, securityPatterns);
  if (agent === "best-practices") return hasAny(text, bestPracticePatterns) && !hasAny(text, securityPatterns);
  if (agent === "quality") return hasAny(text, qualityPatterns) && !hasAny(text, securityPatterns);
  return true; // Default: accept all (should not reach here with current agent list)
}

// ─── Code Context Builder ─────────────────────────────────────────────────────

/**
 * Builds the code context string sent to each agent for a specific file.
 * Includes:
 *   - File metadata (path, language, risk level, areas of concern)
 *   - Lines changed in this PR (for accurate line number references)
 *   - Full file content (for complete review, not just diff lines)
 *
 * Falls back to context lines from the diff if full file isn't available.
 *
 * @param file - The triaged file to build context for
 * @returns Formatted string with file metadata and code content
 */
function buildCodeContext(file: TriagedFile): string {
  // Format changed lines with line numbers: "42: const foo = 'bar';"
  const changedLines = file.addedLines.map((line) => `${line.line}: ${line.content}`).join("\n");

  // Use full file content if available (preferred), fall back to diff context lines
  const fullFileLines = (file.fullFileLines?.length ? file.fullFileLines : file.contextLines)
    .map((line) => `${line.line}: ${line.content}`)
    .join("\n");

  // Build a structured context block that agents can reason about
  return [
    `File: ${file.file}`,
    `Language: ${file.language}`,
    `Risk level: ${file.triage.risk_level}`,
    `Areas of concern: ${file.triage.areas_of_concern.join(", ") || "general"}`,
    "",
    // Instruct the agent to use changed lines for line number references, not as the review scope
    "Lines changed in this PR (use for line number reference only — do NOT limit your review to these lines):",
    changedLines || "(no added lines)",
    "",
    // The full file is where the agent should find and report issues
    "Current full file content (review this entirely for issues, including pre-existing ones):",
    fullFileLines || "(file content unavailable)"
  ].join("\n");
}

// ─── Response Format Instruction ─────────────────────────────────────────────

/**
 * Instruction appended to every agent's system prompt.
 * Tells the AI exactly what JSON format to return and how to handle edge cases.
 *
 * Key constraints:
 *   - No markdown fences (would break JSON parsing)
 *   - Include concrete fix code when possible
 *   - Review the ENTIRE file, not just changed lines
 *   - Prefer zero findings over uncertain ones
 *   - Stay in scope (security agent should NOT report lint issues)
 */
const JSON_INSTRUCTION = `
Respond ONLY with valid JSON in this exact format - no markdown fences, no prose:
{"issues":[{"line":<number>,"title":"<string>","message":"<string>","severity":"critical|high|medium|low","code_snippet":"<string>","suggestion":"<string>","fix":"<string>"}]}
When possible, provide a concrete corrected code snippet in "fix". Do not return generic advice if you can show an exact code change.
IMPORTANT: Review the ENTIRE "Current full file content" for issues — not only the changed lines. Pre-existing issues anywhere in the file must be reported if the file was touched in this PR. Use the changed lines only to assign accurate line numbers to your findings.
If an issue does not clearly belong to your assigned review scope, do not report it.
Prefer zero findings over low-confidence or out-of-scope findings.
If there are no issues, return: {"issues":[]}`.trim();

// ─── Agent Specifications ─────────────────────────────────────────────────────

/**
 * All 9 specialized agent configurations.
 * Each agent has a unique system prompt that defines its persona and
 * exactly what it MUST report. The "MUST report" list prevents agents
 * from skipping issues they'd normally mention but not flag as findings.
 *
 * Order here determines processing order in reviewFileWithAI().
 * Security is always processed first (separate function: runAISecurityAgent).
 */
const AGENT_SPECS: AgentSpec[] = [
  {
    agent: "security",
    category: "security",
    confidence: 0.88,    // High confidence — security agent is strict and focused
    label: "security",
    maxTokens: 1200,     // Larger budget — security issues need detailed fixes
    system: `You are an expert application security engineer. Be thorough — missing a real vulnerability is worse than a false positive.
You MUST report every instance of:
- Hardcoded secrets, passwords, tokens, API keys (e.g. const SECRET = "...", apiKey = "...")
- dangerouslySetInnerHTML with unsanitized or prop-sourced HTML
- Sensitive data logged to console (passwords, tokens, emails)
- Token or credential leakage in URLs (router.push("...?token="))
- XSS vectors: javascript: URLs in href, inline event handlers that call alert/eval, unsanitized props rendered as HTML
- Open redirects using user-controlled input
- Password input fields using type="text" instead of type="password"
- SQL/command injection via string interpolation
- Insecure image or script sources using unsanitized props (e.g. src={props.img})
Do NOT report style, performance, or general code quality issues.
${JSON_INSTRUCTION}`
  },
  {
    agent: "bug",
    category: "bug",
    confidence: 0.85,    // High confidence — bug patterns are fairly unambiguous
    label: "bug",
    maxTokens: 1100,
    system: `You are a senior software engineer doing a strict bug review. Report every real runtime or correctness bug you find.
You MUST report every instance of:
- Infinite loops or functions that permanently block the thread (while(true), for loops with no exit)
- Missing return/guard after setting error state — execution that continues past a validation failure
- Unhandled promise rejections or missing await on async calls
- Race conditions between async operations and state updates (e.g. setLoading after await with no cleanup)
- Null/undefined dereference risks
- Dead code: functions defined but never meaningfully called, results computed and discarded
- setLoading(false) or similar cleanup missing from error paths
Do NOT report security or style issues.
${JSON_INSTRUCTION}`
  },
  {
    agent: "logic",
    category: "bug",
    confidence: 0.82,    // Slightly lower — logic errors require more context to confirm
    label: "logic",
    maxTokens: 1100,
    system: `You are a senior software engineer doing a strict logic review. Report every logic flaw you find — do not skip obvious ones.
You MUST report every instance of:
- Loose equality (== or !=) where strict equality (=== or !==) is needed
- Validation that runs setError but does not return — execution falls through incorrectly
- Conditions that are always true or always false
- Hardcoded credentials used in comparison logic (e.g. email === "user@example.com")
- Business logic that bypasses proper authentication or authorization
- Wrong operator precedence or incorrect boolean logic
- UI state that can get out of sync (e.g. setLoading(true) without guaranteed setLoading(false))
Do NOT report security issues that belong to the security agent.
${JSON_INSTRUCTION}`
  },
  {
    agent: "types",
    category: "quality",
    confidence: 0.80,
    label: "types",
    maxTokens: 1000,
    system: `You are a TypeScript expert doing a strict type-safety review. Report every type weakness you find.
You MUST report every instance of:
- useState<any> — state variables typed as any instead of a concrete type
- Function parameters or event handlers typed as any (e.g. (e: any) => ...)
- Component props typed as any instead of a proper interface
- Missing return types on functions with non-trivial logic
- Type assertions (as X) that hide real type mismatches
- Unsafe optional chaining used to silence errors instead of handling them
- Inconsistent types between what is stored and what is used
Do NOT report security or performance issues.
${JSON_INSTRUCTION}`
  },
  {
    agent: "eslint",
    category: "quality",
    confidence: 0.78,
    label: "eslint",
    maxTokens: 900,      // Smaller budget — lint issues are usually simple
    system: `You are a linting expert doing a strict static code review. Report every lint violation you find.
You MUST report every instance of:
- console.log, console.error, or console.warn left in production code paths
- Variables or functions declared but never used
- Inline arrow functions passed to onClick or similar JSX props that do nothing useful (e.g. onClick={()=>Math.random()})
- Loose equality (== or !=) instead of strict equality
- Missing React hook dependency array entries
- Unused imports
- Event handlers with no meaningful side effect
Do NOT report security or performance issues.
${JSON_INSTRUCTION}`
  },
  {
    agent: "performance",
    category: "performance",
    confidence: 0.81,
    label: "performance",
    maxTokens: 950,
    system: `You are a performance engineering expert doing a strict performance review. Report every performance problem you find.
You MUST report every instance of:
- Heavy synchronous computation inside event handlers or render (e.g. loops with millions of iterations)
- Blocking the UI thread with synchronous busy-wait loops (while(true), large for loops on click)
- Math.random() or Date.now() called on every render or inside JSX
- Functions defined inside render or JSX that are recreated on every render
- Missing useMemo or useCallback for expensive values or callbacks passed as props
- Duplicate expensive operations that could be cached
- Artificial delays (setTimeout) that block useful work without a clear reason
Do NOT report security issues.
${JSON_INSTRUCTION}`
  },
  {
    agent: "best-practices",
    category: "quality",
    confidence: 0.77,
    label: "best-practices",
    maxTokens: 950,
    system: `You are a senior engineer doing a strict best-practices review. Report every engineering practice violation you find.
You MUST report every instance of:
- Hardcoded values that should be environment variables or constants (credentials, URLs, magic strings)
- Authentication or business logic embedded directly inside UI components
- Functions exposed in the UI that serve no purpose or are dangerous (e.g. a button that freezes the app)
- Missing error handling around operations that can fail
- Component responsibilities mixed together (data fetching + validation + rendering in one place)
- Props used without validation or default values in critical paths
- No separation between UI state and business rules
Do NOT report security issues that belong to the security agent.
${JSON_INSTRUCTION}`
  },
  {
    agent: "quality",
    category: "quality",
    confidence: 0.75,    // Lowest confidence — quality issues are often subjective
    label: "quality",
    maxTokens: 900,
    system: `You are a software architect doing a strict React/Next.js quality review. Report every quality issue you find.
You MUST report every instance of:
- Link or anchor elements with href set to javascript: URLs or other non-navigation values
- dangerouslySetInnerHTML used without a clear sanitization comment or wrapper
- img or media elements with onError handlers that call alert or expose internal state
- Side effects (API calls, mutations) inside the render body instead of useEffect
- Missing loading or error states for async operations shown in UI
- Components too large to maintain — doing more than one job
- Duplicate logic that should be extracted to a hook or utility
Do NOT report security issues that belong to the security agent.
${JSON_INSTRUCTION}`
  }
];

// ─── Agent Runner Functions ───────────────────────────────────────────────────

/**
 * Runs a single AI security agent on a file.
 * Calls the AI with the security-focused system prompt and parses the response.
 * Filters returned issues through issueBelongsToAgent() to keep only security issues.
 *
 * Returns SecurityIssue[] (not ReviewIssue[]) because security findings have
 * a different shape (fix vs. suggestion, always category="security").
 *
 * @param file - The triaged file to review
 * @param spec - The security agent specification
 * @returns Array of SecurityIssue objects, or [] if AI fails or returns nothing
 */
async function runAISecurityAgent(file: TriagedFile, spec: AgentSpec): Promise<SecurityIssue[]> {
  // Call the AI with the agent's system prompt and the file's code context
  const text = await callAI(spec.system, buildCodeContext(file), spec.maxTokens);
  if (!text) return []; // No AI available or call failed

  // Parse the AI's JSON response
  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return []; // No issues found or bad response format

  // Filter to only security-related issues and normalize into SecurityIssue objects
  return parsed.issues
    .filter((issue) => issueBelongsToAgent(spec.agent, issue)) // Keep only security-scope issues
    .map((issue) => ({
      id: `S-ai-${file.file}-${issue.line}-${spec.agent}`, // Unique ID: S-ai-{file}-{line}-{agent}
      category: "security",          // Always "security" for security agent findings
      severity: issue.severity,
      agent: "security",             // Always attributed to the security agent
      file: file.file,
      line: issue.line,
      code_snippet: issue.code_snippet,
      title: issue.title,
      message: issue.message,
      fix: issue.fix ?? issue.suggestion ?? "",             // Prefer fix over suggestion
      corrected_code: issue.fix ?? issue.suggestion,
      labels: [spec.label, issue.severity],                 // e.g., ["security", "critical"]
      confidence: spec.confidence                           // Agent-level confidence score (0.88)
    }));
}

/**
 * Runs a single AI review agent (non-security) on a file.
 * Same structure as runAISecurityAgent but returns ReviewIssue[] instead.
 * The category is taken from the agent spec (bug, performance, quality).
 *
 * @param file - The triaged file to review
 * @param spec - The agent specification (bug, logic, types, eslint, performance, etc.)
 * @returns Array of ReviewIssue objects, or [] if AI fails or returns nothing
 */
async function runAIReviewAgent(file: TriagedFile, spec: AgentSpec): Promise<ReviewIssue[]> {
  const text = await callAI(spec.system, buildCodeContext(file), spec.maxTokens);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues
    .filter((issue) => issueBelongsToAgent(spec.agent, issue)) // Keep only in-scope issues
    .map((issue) => ({
      id: `R-ai-${spec.agent}-${file.file}-${issue.line}`, // Unique ID: R-ai-{agent}-{file}-{line}
      category: spec.category,      // bug, performance, or quality
      severity: issue.severity,
      agent: spec.agent,            // Which agent found this
      file: file.file,
      line: issue.line,
      code_snippet: issue.code_snippet,
      title: issue.title,
      message: issue.message,
      suggestion: issue.suggestion ?? issue.fix ?? "",  // Advisory text
      corrected_code: issue.fix,                        // Concrete code fix
      labels: [spec.label, issue.severity],             // e.g., ["bug", "medium"]
      confidence: spec.confidence                       // Agent-level confidence score
    }));
}

// ─── Per-File Review ──────────────────────────────────────────────────────────

/**
 * Runs all 9 agents on a single file using Promise.all for parallel execution.
 * The security agent runs separately (different return type) and the rest run together.
 * Collects findings and auto-generated patches into a ReviewFileResult.
 *
 * @param file - The triaged file to review
 * @returns Complete ReviewFileResult with findings from all 9 agents
 */
async function reviewFileWithAI(file: TriagedFile): Promise<ReviewFileResult> {
  // Separate security from other agents (different return type: SecurityIssue vs ReviewIssue)
  const securitySpec = AGENT_SPECS.find((spec) => spec.agent === "security")!;
  const reviewSpecs = AGENT_SPECS.filter((spec) => spec.agent !== "security");

  // Run all agents in parallel — security + all review agents simultaneously
  // This means 9 concurrent AI calls, one per agent
  const [securityIssues, ...reviewIssueSets] = await Promise.all([
    runAISecurityAgent(file, securitySpec),                   // Security agent (returns SecurityIssue[])
    ...reviewSpecs.map((spec) => runAIReviewAgent(file, spec)) // 8 review agents (return ReviewIssue[])
  ]);

  // Flatten the per-agent review issue arrays into a single list
  const reviewIssues = reviewIssueSets.flat();

  // Build patches from any finding that has a corrected_code
  const patches: Patch[] = [...securityIssues, ...reviewIssues]
    .filter((issue) => issue.corrected_code)  // Only issues with a concrete fix
    .map((issue) => ({
      file: file.file,
      line: issue.line,
      original: issue.code_snippet,
      fixed: issue.corrected_code as string   // Safe because we filtered above
    }));

  return {
    file: file.file,
    language: file.language,
    changed_lines: file.addedLines.map((line) => line.line), // Line numbers from the diff
    triage: file.triage,
    review: { issues: reviewIssues },
    security: { vulnerabilities: securityIssues },
    fix: {
      required: patches.length > 0,
      fixed_code: patches.map((patch) => patch.fixed).join("\n"), // All fix suggestions joined
      patches,
      changes_summary: patches.map((patch) => `Line ${patch.line}: ${patch.fixed.slice(0, 80)}`) // First 80 chars
    }
  };
}

// ─── Comment & Agent Run Builders ─────────────────────────────────────────────

/**
 * Converts a ReviewIssue or SecurityIssue into a formatted PRComment.
 * The comment body is formatted as markdown for GitHub PR display.
 *
 * @param issue - The finding to convert
 * @returns A PRComment with a markdown-formatted body
 */
function buildComment(issue: ReviewIssue | SecurityIssue): PRComment {
  // Get the best available fix code from whichever field is populated
  const correctedCode =
    "corrected_code" in issue && issue.corrected_code
      ? issue.corrected_code
      : "fix" in issue
        ? issue.fix       // SecurityIssue uses `fix`
        : issue.suggestion; // ReviewIssue uses `suggestion`

  return {
    id: issue.id,
    file: issue.file,
    line: issue.line,
    agent: issue.agent,
    severity: issue.severity,
    category: issue.category,
    title: issue.title,
    issue: issue.message,
    code_snippet: issue.code_snippet,
    corrected_code: correctedCode,
    labels: issue.labels,
    // Markdown body for GitHub PR comment display
    body: [
      `**${issue.title}**`,
      `File: \`${issue.file}\` - Line: ${issue.line}`,
      `Severity: \`${issue.severity}\``,
      "",
      issue.message,
      "",
      correctedCode ? `**Suggested fix:**\n\`\`\`\n${correctedCode}\n\`\`\`` : ""
    ].filter(Boolean).join("\n")
  };
}

/**
 * Builds the agent_runs summary showing finding counts per agent.
 * "fix" agent count = total number of auto-generated patches (not a review agent).
 *
 * @param files - All reviewed file results
 * @returns Array of AgentRunSummary, one per agent name
 */
function buildAgentRuns(files: ReviewFileResult[]): AgentRunSummary[] {
  const allIssues = files.flatMap((file) => [...file.review.issues, ...file.security.vulnerabilities]);
  const patchCount = files.reduce((count, file) => count + file.fix.patches.length, 0);

  return (["security", "bug", "logic", "types", "eslint", "performance", "best-practices", "quality", "fix"] as const).map((agent) => ({
    agent,
    findings: agent === "fix" ? patchCount : allIssues.filter((issue) => issue.agent === agent).length,
    status: "completed" as const // Always "completed" — failed agents return [] not errors
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs the AI multi-agent pipeline on all triaged files.
 * Called by MultiAgentProvider.review().
 *
 * FLOW:
 *   1. For each file, run all 9 specialized AI agents in parallel
 *   2. Collect all findings and patches
 *   3. If ALL agents found nothing across ALL files → run local pattern fallback
 *   4. Finalize: deduplicate, count, decide approve/request_changes
 *
 * FALLBACK CONDITION:
 *   Zero findings from all AI agents means either:
 *     a) No AI is configured → callAI returns null → agents return []
 *     b) AI returned no issues (possible on simple/clean diffs)
 *     c) AI response was unparseable
 *   In all these cases, local pattern agents provide a safety net.
 *
 * @param triagedFiles - Files with diff content and risk triage
 * @returns ReviewResult from AI agents (or local pattern fallback)
 */
export async function runAIAgentPipeline(triagedFiles: TriagedFile[]): Promise<ReviewResult> {
  const result = createEmptyReview(triagedFiles); // Start with clean empty structure

  // Run all agents on all files — files are processed in parallel too
  const fileResults = await Promise.all(triagedFiles.map((file) => reviewFileWithAI(file)));

  // Check if any agent found anything at all across all files
  const hasAnyFindings = fileResults.some((file) =>
    file.review.issues.length > 0 || file.security.vulnerabilities.length > 0
  );

  // If no findings at all, fall back to local pattern agents.
  // This handles both "no AI configured" and "AI returned nothing" cases.
  if (!hasAnyFindings) {
    return runLocalAgentPipeline(triagedFiles);
  }

  // Populate the result with AI agent findings
  result.files = fileResults;

  // Build PR comments from all findings across all files
  result.reports.pr_comments = fileResults.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map(buildComment)
  );

  // Build agent run summary (finding counts per agent)
  result.reports.agent_runs = buildAgentRuns(fileResults);

  // Deduplicate, count severities, decide approve/request_changes, build markdown summary
  return finalizeSummary(result);
}
