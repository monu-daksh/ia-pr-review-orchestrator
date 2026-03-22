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

interface AIReviewIssue {
  line: number;
  title: string;
  message: string;
  severity: Severity;
  code_snippet: string;
  suggestion?: string;
  fix?: string;
}

interface AIAgentResponse {
  issues: AIReviewIssue[];
}

interface AgentSpec {
  agent: Exclude<AgentName, "fix">;
  category: "security" | "bug" | "performance" | "quality";
  system: string;
  maxTokens: number;
  confidence: number;
  label: string;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function issueText(issue: AIReviewIssue): string {
  return normalizeText(`${issue.title} ${issue.message} ${issue.code_snippet} ${issue.suggestion ?? ""} ${issue.fix ?? ""}`);
}

function hasAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function issueBelongsToAgent(agent: Exclude<AgentName, "fix">, issue: AIReviewIssue): boolean {
  const text = issueText(issue);

  const securityPatterns = [
    "secret", "api key", "token", "password", "xss", "dangerouslysetinnerhtml", "redirect",
    "javascript", "injection", "sanitize", "unsafe url", "script src", "img src", "console log secret"
  ];
  const bugPatterns = [
    "null", "undefined", "promise", "unhandled", "race condition", "memory leak", "infinite loop",
    "freeze", "crash", "async misuse", "unreachable", "dead code"
  ];
  const logicPatterns = [
    "wrong condition", "loose equality", "==", "mutation", "incorrect calculation", "incorrect transformation",
    "inconsistent", "invalid assumption", "edge case", "business logic"
  ];
  const performancePatterns = [
    "performance", "expensive", "memo", "usememo", "usecallback", "re render", "rerender",
    "math random", "date now", "blocking", "large loop", "heavy computation", "duplicate expensive"
  ];
  const eslintPatterns = [
    "unused", "console", "inline function", "formatting", "naming", "hook dependency", "loose equality", "style"
  ];
  const typePatterns = [
    "any", "type", "interface", "props", "state", "optional chaining", "type assertion", "typed", "typescript"
  ];
  const bestPracticePatterns = [
    "hardcoded", "separation of concerns", "error handling", "direct dom", "reusability", "component structure"
  ];
  const qualityPatterns = [
    "key prop", "hydration", "side effect", "link usage", "loading state", "error state", "bundle size",
    "extract component", "duplicate code", "readability", "maintainability", "large component", "nested condition"
  ];

  if (agent === "security") return hasAny(text, securityPatterns);
  if (agent === "bug") return hasAny(text, bugPatterns) && !hasAny(text, securityPatterns);
  if (agent === "logic") return hasAny(text, logicPatterns) && !hasAny(text, securityPatterns);
  if (agent === "performance") return hasAny(text, performancePatterns) && !hasAny(text, securityPatterns);
  if (agent === "eslint") return hasAny(text, eslintPatterns) && !hasAny(text, securityPatterns);
  if (agent === "types") return hasAny(text, typePatterns) && !hasAny(text, securityPatterns);
  if (agent === "best-practices") return hasAny(text, bestPracticePatterns) && !hasAny(text, securityPatterns);
  if (agent === "quality") return hasAny(text, qualityPatterns) && !hasAny(text, securityPatterns);
  return true;
}

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
    "Lines changed in this PR (use for line number reference only — do NOT limit your review to these lines):",
    changedLines || "(no added lines)",
    "",
    "Current full file content (review this entirely for issues, including pre-existing ones):",
    fullFileLines || "(file content unavailable)"
  ].join("\n");
}

const JSON_INSTRUCTION = `
Respond ONLY with valid JSON in this exact format - no markdown fences, no prose:
{"issues":[{"line":<number>,"title":"<string>","message":"<string>","severity":"critical|high|medium|low","code_snippet":"<string>","suggestion":"<string>","fix":"<string>"}]}
When possible, provide a concrete corrected code snippet in "fix". Do not return generic advice if you can show an exact code change.
IMPORTANT: Review the ENTIRE "Current full file content" for issues — not only the changed lines. Pre-existing issues anywhere in the file must be reported if the file was touched in this PR. Use the changed lines only to assign accurate line numbers to your findings.
If an issue does not clearly belong to your assigned review scope, do not report it.
Prefer zero findings over low-confidence or out-of-scope findings.
If there are no issues, return: {"issues":[]}`.trim();

const AGENT_SPECS: AgentSpec[] = [
  {
    agent: "security",
    category: "security",
    confidence: 0.88,
    label: "security",
    maxTokens: 1200,
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
    confidence: 0.85,
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
    confidence: 0.82,
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
    confidence: 0.8,
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
    maxTokens: 900,
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
    confidence: 0.75,
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

async function runAISecurityAgent(file: TriagedFile, spec: AgentSpec): Promise<SecurityIssue[]> {
  const text = await callAI(spec.system, buildCodeContext(file), spec.maxTokens);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues
    .filter((issue) => issueBelongsToAgent(spec.agent, issue))
    .map((issue) => ({
    id: `S-ai-${file.file}-${issue.line}-${spec.agent}`,
    category: "security",
    severity: issue.severity,
    agent: "security",
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet,
    title: issue.title,
    message: issue.message,
    fix: issue.fix ?? issue.suggestion ?? "",
    corrected_code: issue.fix ?? issue.suggestion,
    labels: [spec.label, issue.severity],
    confidence: spec.confidence
  }));
}

async function runAIReviewAgent(file: TriagedFile, spec: AgentSpec): Promise<ReviewIssue[]> {
  const text = await callAI(spec.system, buildCodeContext(file), spec.maxTokens);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues
    .filter((issue) => issueBelongsToAgent(spec.agent, issue))
    .map((issue) => ({
    id: `R-ai-${spec.agent}-${file.file}-${issue.line}`,
    category: spec.category,
    severity: issue.severity,
    agent: spec.agent,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet,
    title: issue.title,
    message: issue.message,
    suggestion: issue.suggestion ?? issue.fix ?? "",
    corrected_code: issue.fix,
    labels: [spec.label, issue.severity],
    confidence: spec.confidence
  }));
}

async function reviewFileWithAI(file: TriagedFile): Promise<ReviewFileResult> {
  const securitySpec = AGENT_SPECS.find((spec) => spec.agent === "security")!;
  const reviewSpecs = AGENT_SPECS.filter((spec) => spec.agent !== "security");

  const [securityIssues, ...reviewIssueSets] = await Promise.all([
    runAISecurityAgent(file, securitySpec),
    ...reviewSpecs.map((spec) => runAIReviewAgent(file, spec))
  ]);

  const reviewIssues = reviewIssueSets.flat();
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
    corrected_code: correctedCode,
    labels: issue.labels,
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

function buildAgentRuns(files: ReviewFileResult[]): AgentRunSummary[] {
  const allIssues = files.flatMap((file) => [...file.review.issues, ...file.security.vulnerabilities]);
  const patchCount = files.reduce((count, file) => count + file.fix.patches.length, 0);

  return (["security", "bug", "logic", "types", "eslint", "performance", "best-practices", "quality", "fix"] as const).map((agent) => ({
    agent,
    findings: agent === "fix" ? patchCount : allIssues.filter((issue) => issue.agent === agent).length,
    status: "completed"
  }));
}

export async function runAIAgentPipeline(triagedFiles: TriagedFile[]): Promise<ReviewResult> {
  const result = createEmptyReview(triagedFiles);
  const fileResults = await Promise.all(triagedFiles.map((file) => reviewFileWithAI(file)));

  const hasAnyFindings = fileResults.some((file) =>
    file.review.issues.length > 0 || file.security.vulnerabilities.length > 0
  );

  if (!hasAnyFindings) {
    return runLocalAgentPipeline(triagedFiles);
  }

  result.files = fileResults;
  result.reports.pr_comments = fileResults.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map(buildComment)
  );
  result.reports.agent_runs = buildAgentRuns(fileResults);

  return finalizeSummary(result);
}
