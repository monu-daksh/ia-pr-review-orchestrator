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
    maxTokens: 1000,
    system: `You are an expert application security engineer performing a focused security review.
Analyze ONLY for these security issues:
- Hardcoded secrets, tokens, passwords, API keys
- XSS, dangerouslySetInnerHTML, unsanitized input
- Open redirects and unsafe URLs
- Sensitive data in logs
- Injection risks
- Insecure image or script sources
- Token leakage in URLs
Do NOT report style, performance, or general code quality issues.
Reject anything outside security scope.
${JSON_INSTRUCTION}`
  },
  {
    agent: "bug",
    category: "bug",
    confidence: 0.85,
    label: "bug",
    maxTokens: 1000,
    system: `You are a senior software engineer performing a focused bug review.
Analyze ONLY for runtime and correctness bugs:
- Null/undefined risks
- Dead code or unreachable code
- Infinite loops
- Race conditions and async misuse
- Mutating data incorrectly
- Incorrect calculations or transformations
Do NOT report security or style issues.
Reject anything outside bug scope.
${JSON_INSTRUCTION}`
  },
  {
    agent: "logic",
    category: "bug",
    confidence: 0.82,
    label: "logic",
    maxTokens: 1000,
    system: `You are a senior software engineer performing a focused logic review.
Analyze ONLY for logic issues:
- Wrong conditions like == instead of ===
- Missing edge cases
- Incorrect algorithms
- Inconsistent UI logic
- Invalid assumptions
- Wrong business behavior
Do NOT report security issues from this agent.
Reject anything outside logic scope.
${JSON_INSTRUCTION}`
  },
  {
    agent: "types",
    category: "quality",
    confidence: 0.8,
    label: "types",
    maxTokens: 900,
    system: `You are a TypeScript and static typing expert performing a focused type-safety review.
Analyze ONLY for:
- any usage
- Missing interfaces or types
- Unsafe optional chaining
- Type assertion misuse
- Props/state/function params not typed
- Inconsistent types
Do NOT report security or performance issues from this agent.
Reject anything outside type-safety scope.
${JSON_INSTRUCTION}`
  },
  {
    agent: "eslint",
    category: "quality",
    confidence: 0.78,
    label: "eslint",
    maxTokens: 800,
    system: `You are a linting and style expert performing a focused static review.
Analyze ONLY for:
- any type usage
- Unused variables or functions
- Inline functions in JSX
- Missing dependencies in hooks
- Extra logs
- Loose equality
- Formatting or naming issues
Do NOT report security or performance issues from this agent.
Reject anything outside lint/style scope.
${JSON_INSTRUCTION}`
  },
  {
    agent: "performance",
    category: "performance",
    confidence: 0.81,
    label: "performance",
    maxTokens: 850,
    system: `You are a performance review expert performing a focused performance review.
Analyze ONLY for:
- Heavy computations in render
- Repeated function calls
- Unnecessary re-renders
- Math.random or Date.now in UI
- Missing memoization
- Large loops or blocking code
- Duplicate expensive operations
Do NOT report security issues from this agent.
Reject anything outside performance scope.
${JSON_INSTRUCTION}`
  },
  {
    agent: "best-practices",
    category: "quality",
    confidence: 0.77,
    label: "best-practices",
    maxTokens: 850,
    system: `You are a senior reviewer focused on engineering best practices.
Analyze ONLY for:
- Hardcoded values
- No separation of concerns
- Business logic inside UI
- No error handling
- Direct DOM manipulation
- Poor component structure
- No reusability
Do NOT report direct security issues from this agent if the security agent would own them.
Reject anything outside best-practices scope.
${JSON_INSTRUCTION}`
  },
  {
    agent: "quality",
    category: "quality",
    confidence: 0.75,
    label: "quality",
    maxTokens: 800,
    system: `You are a software architect performing a focused React, Next.js, maintainability, and optimization review.
Analyze ONLY for:
- Using index or random as keys
- Hydration issues like Math.random or Date.now in SSR
- Side effects inside render
- Improper Link usage
- Missing loading or error states
- Duplicate code
- Complex functions or large components
- Poor readability or maintainability
Do NOT report direct security issues from this agent if the security agent would own them.
Reject anything outside maintainability/react-quality scope.
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
