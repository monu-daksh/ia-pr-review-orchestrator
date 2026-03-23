/**
 * ============================================================
 * FILE: src/agents/ai-agents.ts
 * PURPOSE: AI-powered multi-agent pipeline.
 *          Runs 8 specialized AI agents in parallel, each with a focused
 *          system prompt, to produce a comprehensive PR review.
 *
 * WHY MULTI-AGENT?
 *   A single "review everything" prompt produces weaker results because
 *   the model spreads attention across security, bugs, types, style, etc.
 *   Specialized agents with narrow, focused prompts find more issues:
 *     - Security agent only thinks about vulnerabilities
 *     - Bug agent only thinks about runtime correctness
 *     - ESLint agent only checks lint rules
 *   Running them in parallel (Promise.all) adds no latency over a single call.
 *
 * AGENTS (8 specialized — each maps exactly to the detection pipeline):
 *   security       → secrets, tokens, XSS, unsafe HTML, injections
 *   bug            → crashes, null issues, async issues, infinite loops
 *   logic          → wrong conditions, loose equality, validation flaws
 *   types          → any usage, missing types, unsafe typing
 *   performance    → heavy loops, blocking UI, re-renders
 *   eslint         → console logs, unused variables, bad patterns
 *   best-practices → hardcoded values, poor structure
 *   quality        → bad React patterns, side effects, large components
 *
 * IMPORTANT — NO KEYWORD FILTERING:
 *   Each agent's findings are accepted as-is from the AI.
 *   We trust each agent's focused system prompt to scope its output.
 *   Deduplication and merging happens in schema.ts AFTER all agents run.
 *   Previously a keyword filter (issueBelongsToAgent) was used here, but it
 *   caused false negatives: e.g., a console.log finding mentioning a "secret"
 *   would be dropped from the eslint agent because it matched security patterns.
 *   Removed entirely — the AI's own system prompt is the scope boundary.
 *
 * FALLBACK:
 *   If ALL agents return zero findings across all files →
 *   runs local pattern agents (runLocalAgentPipeline) as a safety net.
 *
 * AI BACKEND:
 *   Each agent calls callAI() from utils/ai-call.ts.
 *   callAI() auto-selects: Claude → Groq → Gemini → Ollama → null
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
import { runJudgePipeline } from "./judge-agent.js";
import { safeJsonParse } from "../utils/json.js";

// ─── Internal Response Types ─────────────────────────────────────────────────

/**
 * Shape of a single issue as returned by each AI agent.
 * AI agents return this simpler format — we normalize it into ReviewIssue/SecurityIssue
 * after all agents complete.
 *
 * `confidence` is optional — AI may or may not return it.
 * Falls back to the agent spec's default confidence if missing.
 */
interface AIReviewIssue {
  line: number;
  title: string;
  message: string;
  severity: Severity;
  confidence?: number;   // AI-provided confidence score (0.0–1.0), optional
  code_snippet: string;
  suggestion?: string;   // Advisory text (used when no concrete fix is available)
  fix?: string;          // Concrete corrected code (preferred over suggestion)
}

/**
 * The JSON response expected from each AI agent.
 * AI is instructed to return ONLY this structure — no prose, no fences.
 */
interface AIAgentResponse {
  issues: AIReviewIssue[];
}

// ─── Agent Spec Definition ────────────────────────────────────────────────────

/**
 * Configuration for a single specialized agent.
 * Each agent has its own:
 *   - system   : focused persona + exact checklist of what to look for
 *   - maxTokens: response budget (security needs more for detailed fixes)
 *   - confidence: default score used if AI doesn't return one
 *   - category : how its findings are classified (bug / security / performance / quality)
 *   - label    : short tag added to each finding from this agent
 */
interface AgentSpec {
  agent: Exclude<AgentName, "fix">;
  category: "security" | "bug" | "performance" | "quality";
  system: string;
  maxTokens: number;
  confidence: number;
  label: string;
}

// ─── Code Context Builder ─────────────────────────────────────────────────────

/**
 * Builds the code context string sent to each agent for a specific file.
 * Includes:
 *   - File metadata (path, language, risk level, areas of concern)
 *   - Lines changed in this PR (for accurate line number references)
 *   - Full file content (for complete review beyond just diff lines)
 *
 * Falls back to context lines from the diff if full file isn't available.
 */
function buildCodeContext(file: TriagedFile): string {
  const changedLines = file.addedLines.map((line) => `${line.line}: ${line.content}`).join("\n");

  const fullFileLines = (file.fullFileLines?.length ? file.fullFileLines : file.contextLines)
    .map((line) => `${line.line}: ${line.content}`)
    .join("\n");

  return [
    `File: ${file.file}`,
    `Language: ${file.language}`,
    `Risk level: ${file.triage.risk_level}`,
    `Areas of concern: ${file.triage.areas_of_concern.join(", ") || "general"}`,
    "",
    "Lines changed in this PR (use for line number reference only):",
    changedLines || "(no added lines)",
    "",
    "Current full file content (review this ENTIRELY — not just the diff):",
    fullFileLines || "(file content unavailable)"
  ].join("\n");
}

// ─── Shared JSON Response Instruction ────────────────────────────────────────

/**
 * Appended to EVERY agent's system prompt.
 * Tells the AI exactly what JSON format to return and the 6-step pipeline to follow.
 *
 * Key rules:
 *   - No markdown fences (breaks JSON parsing)
 *   - Include `confidence` (0.0–1.0) per finding
 *   - Review the ENTIRE file, not just changed lines
 *   - Provide concrete `fix` code — not generic advice
 *   - Stay strictly in scope — your system prompt defines your domain
 */
const JSON_INSTRUCTION = `
Respond ONLY with valid JSON. No markdown fences, no prose, no explanation outside JSON.

Exact format:
{"issues":[{"line":<number>,"title":"<string>","message":"<string>","severity":"critical|high|medium|low","confidence":<0.0-1.0>,"code_snippet":"<string>","fix":"<string>"}]}

Follow this pipeline before outputting:
STEP 1 — DETECTION: Find ALL issues within your assigned scope across the ENTIRE file.
STEP 2 — AGGREGATION: Merge duplicates. Keep the most complete version of each issue.
STEP 3 — DECISION ENGINE: Remove false positives. Only real, high-confidence issues. Severity: critical=crash/security, high=major bug/logic, medium=performance/maintainability, low=minor.
STEP 4 — CONTEXT: Consider full file context. Do NOT report issues outside your assigned scope.
STEP 5 — SELF-CHECK: If output is weak or empty, re-check the file once to catch missed issues.
STEP 6 — FIX: For every issue, provide CONCRETE corrected code in "fix". No generic advice.

Rules:
- Review the ENTIRE "Current full file content" — not only the changed lines.
- Use changed lines ONLY to assign accurate line numbers to your findings.
- ONLY report issues inside your specific assigned scope (defined by your persona above).
- Prefer 0 findings over uncertain or out-of-scope findings.
- Empty result: {"issues":[]}`.trim();

// ─── Agent Specifications ─────────────────────────────────────────────────────

/**
 * All 8 specialized agent configurations.
 *
 * Each agent has:
 *   1. A focused persona ("You are an expert X")
 *   2. A "MUST report" checklist — prevents agents from skipping obvious issues
 *   3. A "Do NOT report" boundary — keeps agents from straying into other domains
 *   4. The shared JSON_INSTRUCTION for format and pipeline compliance
 *
 * These 8 agents map exactly to the detection pipeline specification:
 *   security → bug → logic → types → performance → eslint → best-practices → quality
 */
const AGENT_SPECS: AgentSpec[] = [
  // ── 1. Security Agent ─────────────────────────────────────────────────────
  {
    agent: "security",
    category: "security",
    confidence: 0.88,
    label: "security",
    maxTokens: 1400,
    system: `You are an expert application security engineer. Your ONLY job is to find security vulnerabilities.
Scope: secrets/tokens, XSS vectors, unsafe HTML, SQL/command injection, open redirects, credential leaks.

You MUST report every instance of:
- Hardcoded secrets, API keys, passwords, tokens in source code
- dangerouslySetInnerHTML with unsanitized or prop-sourced HTML
- Sensitive data logged to console (passwords, tokens, session IDs, user credentials)
- Token or credential leakage in URLs (e.g. fetch(url + "?token=" + secret))
- XSS: javascript: URLs in href/src, inline event handlers calling alert/eval
- Unsanitized user input rendered as HTML or used in dangerous props
- Open redirects driven by user-controlled data
- Password fields typed as type="text" (exposes password in plain text)
- SQL or command injection via string interpolation
- iframes, images, or scripts sourcing from unsanitized user-controlled props
- Cookies set with sensitive values in plain text (without HttpOnly/Secure flags)
- contentEditable or innerHTML driven by unvalidated props

Do NOT report performance, types, lint, or general code quality issues.
${JSON_INSTRUCTION}`
  },

  // ── 2. Bug Agent ──────────────────────────────────────────────────────────
  {
    agent: "bug",
    category: "bug",
    confidence: 0.85,
    label: "bug",
    maxTokens: 1200,
    system: `You are a senior software engineer. Your ONLY job is to find runtime bugs and crashes.
Scope: crashes, null/undefined issues, async bugs, infinite loops, state mutation bugs.

You MUST report every instance of:
- Infinite loops or functions that permanently block the JS thread (while(true), unbounded for loops on user action)
- Direct object mutation instead of creating new references (e.g. obj[key] = val then setState(obj) — React won't re-render)
- Missing return/guard after setting error state — execution that falls through a validation failure
- Unhandled promise rejections or missing await on async calls
- Race conditions: state updates after async calls with no cleanup (e.g. setLoading after unmounted component)
- Null or undefined dereference that will throw at runtime
- Missing cleanup in useEffect (timers, subscriptions, event listeners not removed)
- setBusy(false) or equivalent cleanup missing from catch/error paths
- Functions or values computed but their result never used (dead computation)

Do NOT report security vulnerabilities, style, or type issues.
${JSON_INSTRUCTION}`
  },

  // ── 3. Logic Agent ────────────────────────────────────────────────────────
  {
    agent: "logic",
    category: "bug",
    confidence: 0.82,
    label: "logic",
    maxTokens: 1200,
    system: `You are a senior software engineer. Your ONLY job is to find logic flaws and incorrect behavior.
Scope: wrong conditions, loose equality, assignment-in-condition, validation flaws, incorrect state transitions.

You MUST report every instance of:
- Assignment operator used where comparison was intended (if(x = y) instead of if(x === y))
- Loose equality (== or !=) where strict equality (=== or !==) should be used
- Conditions that are always true or always false due to wrong logic
- Validation that sets an error but does NOT return — execution falls through incorrectly
- Hardcoded credentials or magic values used in comparison logic (e.g. username === "admin")
- Business logic that bypasses authentication (e.g. hardcoded admin check)
- Wrong boolean operator (|| vs &&) that changes the intended logic
- UI state that can get permanently out of sync (loading=true with no guaranteed reset to false)
- Incorrect operator precedence that changes evaluation order

Do NOT report security vulnerabilities. Focus on logic correctness only.
${JSON_INSTRUCTION}`
  },

  // ── 4. Types Agent ────────────────────────────────────────────────────────
  {
    agent: "types",
    category: "quality",
    confidence: 0.80,
    label: "types",
    maxTokens: 1100,
    system: `You are a TypeScript expert. Your ONLY job is to find type safety violations.
Scope: any usage, missing types, unsafe typing, props typed as any, missing interfaces.

You MUST report every instance of:
- Component props typed as "any" — must have a proper interface or type
- useState<any> or useReducer<any> — state typed as any instead of concrete type
- Event handler parameters typed as any (e.g. (e: any) => ..., onChange={(e:any)=>...})
- Function parameters typed as any when a specific type is available
- Missing return types on exported functions with non-trivial logic
- Type assertions (as SomeType) that hide real type errors
- Implicit any from untyped destructuring or function parameters
- Inconsistent types between stored value and actual usage

Do NOT report security, performance, or logic issues. Focus on TypeScript type safety only.
${JSON_INSTRUCTION}`
  },

  // ── 5. Performance Agent ──────────────────────────────────────────────────
  {
    agent: "performance",
    category: "performance",
    confidence: 0.81,
    label: "performance",
    maxTokens: 1100,
    system: `You are a performance engineering expert. Your ONLY job is to find performance problems.
Scope: heavy loops, blocking UI, unnecessary re-renders, expensive operations in hot paths.

You MUST report every instance of:
- Heavy synchronous computation (large loops, 100k+ iterations) executed inside React render body or JSX
- Heavy computation called directly in JSX like {heavy()} — runs on every render
- Blocking the UI thread with synchronous busy-wait loops (while(true), for loops on button click)
- Math.random() or Date.now() called on every render (in JSX, className, or component body outside useMemo)
- Using Math.random() as a React list key — causes full list re-mount on every render
- Inline functions in JSX props recreated on every render (onClick={()=>...}) that should be useCallback
- Missing useMemo for expensive derived values passed down as props
- Missing useCallback for stable function references passed as props to child components
- useEffect with missing dependency array — runs on every single render

Do NOT report security or logic issues. Focus on render performance and blocking operations only.
${JSON_INSTRUCTION}`
  },

  // ── 6. ESLint Agent ───────────────────────────────────────────────────────
  {
    agent: "eslint",
    category: "quality",
    confidence: 0.78,
    label: "eslint",
    maxTokens: 1000,
    system: `You are a static analysis and linting expert. Your ONLY job is to find lint violations and bad code patterns.
Scope: console logs, unused code, bad patterns, hook violations, useless event handlers.

You MUST report every instance of:
- console.log, console.error, console.warn, console.debug left in production code
- Variables declared but never read or used (const/let/var that are unused)
- Imports that are never used in the file
- onClick or other event handlers that do nothing useful (e.g. onClick={()=>Math.random()}, onClick={()=>{}})
- Loose equality operators (== or !=) — should use === or !==
- React useEffect with a missing or incomplete dependency array
- var keyword usage instead of const or let
- Unreachable code after return statements

Do NOT report security vulnerabilities or performance issues. Focus on static analysis patterns only.
${JSON_INSTRUCTION}`
  },

  // ── 7. Best Practices Agent ───────────────────────────────────────────────
  {
    agent: "best-practices",
    category: "quality",
    confidence: 0.77,
    label: "best-practices",
    maxTokens: 1050,
    system: `You are a senior software architect. Your ONLY job is to find engineering best practice violations.
Scope: hardcoded values, poor structure, missing error handling, bad component design.

You MUST report every instance of:
- Hardcoded URLs, credentials, or configuration values that should be environment variables
- Authentication or authorization logic embedded directly inside UI render components
- UI buttons or actions that expose dangerous operations (e.g. a button labeled "crash" that calls freeze())
- Missing error handling around fetch calls, async operations, or operations that can fail
- Component doing too many jobs: data fetching + validation + business logic + rendering all mixed together
- Props consumed without null checking in critical paths (renders may crash on undefined)
- No separation between UI state (loading, error) and business rules (validation, auth)
- Magic numbers or magic strings inline in JSX instead of named constants

Do NOT report security vulnerabilities. Focus on engineering structure and practices.
${JSON_INSTRUCTION}`
  },

  // ── 8. Quality Agent ──────────────────────────────────────────────────────
  {
    agent: "quality",
    category: "quality",
    confidence: 0.75,
    label: "quality",
    maxTokens: 1000,
    system: `You are a React/Next.js software architect. Your ONLY job is to find code quality and React pattern violations.
Scope: bad React patterns, side effects in render body, missing states, large components, XSS-adjacent rendering.

You MUST report every instance of:
- Side effects (API calls, localStorage writes, mutations) directly in the component render body instead of useEffect
- useEffect without a dependency array — causes infinite re-render loop
- Missing loading state: async operations that show no visual feedback while in progress
- Missing error state: async operations that fail silently with no user-visible error message
- Component that is too large and handles too many concerns (should be split into smaller components)
- Duplicate logic repeated in multiple places that should be extracted to a custom hook or utility
- Unstable list keys (using Math.random() or array index as React key)
- Date.now() or random values rendered directly in JSX — causes hydration mismatches in Next.js

Do NOT report security vulnerabilities. Focus on React patterns and component quality.
${JSON_INSTRUCTION}`
  }
];

// ─── Agent Runner Functions ───────────────────────────────────────────────────

/**
 * Runs the security agent on a file.
 * Returns SecurityIssue[] (different shape from ReviewIssue — always category="security").
 *
 * NOTE: No keyword filtering is applied here. The agent's system prompt defines
 * its scope. All issues returned by the AI are accepted and tagged with agent="security".
 * Deduplication in schema.ts handles any overlap with other agents.
 */
async function runAISecurityAgent(file: TriagedFile, spec: AgentSpec): Promise<SecurityIssue[]> {
  const text = await callAI(spec.system, buildCodeContext(file), spec.maxTokens);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
    id: `S-ai-${file.file}-${issue.line}-security`,
    category: "security" as const,
    severity: issue.severity,
    agent: "security" as const,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet ?? "",
    title: issue.title,
    message: issue.message,
    fix: issue.fix ?? issue.suggestion ?? "",
    corrected_code: issue.fix ?? issue.suggestion,
    labels: [spec.label, issue.severity],
    // Use AI-provided confidence if present, fall back to agent spec default
    confidence: typeof issue.confidence === "number" ? issue.confidence : spec.confidence
  }));
}

/**
 * Runs a single non-security review agent on a file.
 * Returns ReviewIssue[] tagged with the agent that produced them.
 *
 * NOTE: No keyword filtering is applied. The agent's system prompt scopes it.
 * The `agent` field on each finding is always set to `spec.agent` — the calling agent.
 * This ensures the output correctly attributes findings even if the AI's description
 * happens to mention terms from another domain (e.g. a bug description mentioning "token").
 */
async function runAIReviewAgent(file: TriagedFile, spec: AgentSpec): Promise<ReviewIssue[]> {
  const text = await callAI(spec.system, buildCodeContext(file), spec.maxTokens);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
    id: `R-ai-${spec.agent}-${file.file}-${issue.line}`,
    category: spec.category,
    severity: issue.severity,
    agent: spec.agent,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet ?? "",
    title: issue.title,
    message: issue.message,
    suggestion: issue.suggestion ?? issue.fix ?? "",
    corrected_code: issue.fix,
    labels: [spec.label, issue.severity],
    // Use AI-provided confidence if present, fall back to agent spec default
    confidence: typeof issue.confidence === "number" ? issue.confidence : spec.confidence
  }));
}

// ─── Per-File Review ──────────────────────────────────────────────────────────

/**
 * Runs all 8 specialized agents on a single file using Promise.all for full parallelism.
 * Security runs separately (different return type: SecurityIssue vs ReviewIssue).
 * All 9 calls are made simultaneously — no serial bottleneck.
 *
 * Findings from all agents are collected without any filtering.
 * Deduplication happens in schema.ts (finalizeSummary → dedupeReviewResult).
 */
async function reviewFileWithAI(file: TriagedFile): Promise<ReviewFileResult> {
  const securitySpec = AGENT_SPECS.find((spec) => spec.agent === "security")!;
  const reviewSpecs  = AGENT_SPECS.filter((spec) => spec.agent !== "security");

  // All 9 agent calls in parallel — security returns SecurityIssue[], others return ReviewIssue[]
  const [securityIssues, ...reviewIssueSets] = await Promise.all([
    runAISecurityAgent(file, securitySpec),
    ...reviewSpecs.map((spec) => runAIReviewAgent(file, spec))
  ]);

  const reviewIssues = reviewIssueSets.flat();

  // Collect patches from any finding that has a concrete fix
  const patches: Patch[] = [...securityIssues, ...reviewIssues]
    .filter((issue) => issue.corrected_code)
    .map((issue) => ({
      file: file.file,
      line: issue.line,
      original: issue.code_snippet,
      fixed: issue.corrected_code as string
    }));

  return {
    file: file.file,
    language: file.language,
    changed_lines: file.addedLines.map((line) => line.line),
    triage: file.triage,
    review: { issues: reviewIssues },
    security: { vulnerabilities: securityIssues },
    fix: {
      required: patches.length > 0,
      fixed_code: patches.map((patch) => patch.fixed).join("\n"),
      patches,
      changes_summary: patches.map((patch) => `Line ${patch.line}: ${patch.fixed.slice(0, 80)}`)
    }
  };
}

// ─── Comment & Agent Run Builders ─────────────────────────────────────────────

/**
 * Converts a ReviewIssue or SecurityIssue into a formatted PRComment.
 */
function buildComment(issue: ReviewIssue | SecurityIssue): PRComment {
  const correctedCode =
    "corrected_code" in issue && issue.corrected_code
      ? issue.corrected_code
      : "fix" in issue
        ? issue.fix
        : issue.suggestion;

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
    corrected_code: correctedCode ?? "",
    labels: issue.labels,
    body: [
      `**${issue.title}**`,
      `File: \`${issue.file}\` — Line: ${issue.line} | Agent: \`${issue.agent}\` | Severity: \`${issue.severity}\``,
      "",
      issue.message,
      "",
      correctedCode?.trim() ? `**Suggested fix:**\n\`\`\`\n${correctedCode}\n\`\`\`` : ""
    ].filter(Boolean).join("\n")
  };
}

/**
 * Builds the agent_runs summary: how many findings each agent produced.
 * The "fix" agent count = total number of auto-generated patches across all agents.
 */
function buildAgentRuns(files: ReviewFileResult[]): AgentRunSummary[] {
  const allIssues   = files.flatMap((file) => [...file.review.issues, ...file.security.vulnerabilities]);
  const patchCount  = files.reduce((n, file) => n + file.fix.patches.length, 0);

  return (["security", "bug", "logic", "types", "eslint", "performance", "best-practices", "quality", "fix"] as const).map((agent) => ({
    agent,
    findings: agent === "fix"
      ? patchCount
      : allIssues.filter((issue) => issue.agent === agent).length,
    status: "completed" as const
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs the full multi-agent + judge pipeline on all triaged files.
 * Called by MultiAgentProvider.review().
 *
 * PIPELINE (6 steps):
 *   1. Run all 8 specialized agents in parallel across all files
 *   2. If zero findings everywhere → local pattern fallback
 *   3. Run Judge Agent per file:
 *        a. Validate each finding (keep / dismiss false positives)
 *        b. Deduplicate cross-agent overlaps
 *        c. Detect gaps — what no agent caught
 *        d. Score each agent (0–1)
 *        e. Retry underperforming agents with gap-targeted prompts
 *   4. Merge retry findings back in
 *   5. finalizeSummary: schema-level dedup, count severities, decide approve/request_changes
 */
export async function runAIAgentPipeline(triagedFiles: TriagedFile[]): Promise<ReviewResult> {
  const result = createEmptyReview(triagedFiles);

  // Step 1 — Run all 8 agents on every file in parallel
  const fileResults = await Promise.all(triagedFiles.map((file) => reviewFileWithAI(file)));

  // Step 2 — Fallback if no AI is available or all calls failed
  const hasAnyFindings = fileResults.some((file) =>
    file.review.issues.length > 0 || file.security.vulnerabilities.length > 0
  );
  if (!hasAnyFindings) {
    return runLocalAgentPipeline(triagedFiles);
  }

  // Step 3–4 — Judge Agent: validate, deduplicate, gap-detect, retry underperforming agents
  // runJudgePipeline mutates fileResults in-place and returns the improved array.
  const judgedResults = await runJudgePipeline(
    fileResults,
    triagedFiles,
    AGENT_SPECS.map((spec) => ({
      agent:      spec.agent,
      category:   spec.category,
      system:     spec.system,
      maxTokens:  spec.maxTokens,
      confidence: spec.confidence
    }))
  );

  // Step 5 — Finalize
  result.files = judgedResults;

  result.reports.pr_comments = judgedResults.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map(buildComment)
  );

  result.reports.agent_runs = buildAgentRuns(judgedResults);

  // Deduplicate, count severities, decide approve/request_changes, build markdown
  return finalizeSummary(result);
}
