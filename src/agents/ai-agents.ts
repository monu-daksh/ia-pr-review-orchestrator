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

function buildCodeContext(file: TriagedFile): string {
  const lines = file.addedLines.map((line) => `${line.line}: ${line.content}`).join("\n");
  return [
    `File: ${file.file}`,
    `Language: ${file.language}`,
    `Risk level: ${file.triage.risk_level}`,
    `Areas of concern: ${file.triage.areas_of_concern.join(", ") || "general"}`,
    "",
    "Added lines in this PR:",
    lines || "(no added lines)"
  ].join("\n");
}

const JSON_INSTRUCTION = `
Respond ONLY with valid JSON in this exact format - no markdown fences, no prose:
{"issues":[{"line":<number>,"title":"<string>","message":"<string>","severity":"critical|high|medium|low","code_snippet":"<string>","suggestion":"<string>"}]}
If there are no issues, return: {"issues":[]}`.trim();

const AGENT_SPECS: AgentSpec[] = [
  {
    agent: "security",
    category: "security",
    confidence: 0.88,
    label: "security",
    maxTokens: 1000,
    system: `You are an expert application security engineer performing a focused security review.
Analyze ONLY for security vulnerabilities: XSS, SQL injection, command injection, CSRF, insecure auth,
secrets in code, insecure deserialization, path traversal, SSRF, open redirects, weak authorization,
and unsafe trust of user input.
Do NOT report style, performance, or general code quality issues.
${JSON_INSTRUCTION}`
  },
  {
    agent: "bug",
    category: "bug",
    confidence: 0.85,
    label: "bug",
    maxTokens: 1000,
    system: `You are a senior software engineer performing a focused bug review.
Analyze ONLY for runtime bugs: unhandled promises, null/undefined dereferences, race conditions,
error-handling gaps, memory leaks, and behavior that will break at runtime.
Do NOT report security or style issues.
${JSON_INSTRUCTION}`
  },
  {
    agent: "logic",
    category: "bug",
    confidence: 0.82,
    label: "logic",
    maxTokens: 1000,
    system: `You are a senior software engineer performing a focused logic review.
Analyze ONLY for logic issues: wrong conditionals, missing edge cases, incorrect algorithms,
incorrect state transitions, invalid assumptions, and wrong business behavior.
${JSON_INSTRUCTION}`
  },
  {
    agent: "types",
    category: "quality",
    confidence: 0.8,
    label: "types",
    maxTokens: 900,
    system: `You are a TypeScript and static typing expert performing a focused type-safety review.
Analyze ONLY for unsafe any usage, unsafe casts, missing null checks, type mismatches,
and public APIs that are too weakly typed.
${JSON_INSTRUCTION}`
  },
  {
    agent: "eslint",
    category: "quality",
    confidence: 0.78,
    label: "eslint",
    maxTokens: 800,
    system: `You are a linting and style expert performing a focused static review.
Analyze ONLY for lint-rule violations, dead code, console statements in production paths,
and highly likely style or consistency problems.
${JSON_INSTRUCTION}`
  },
  {
    agent: "performance",
    category: "performance",
    confidence: 0.81,
    label: "performance",
    maxTokens: 850,
    system: `You are a performance review expert performing a focused performance review.
Analyze ONLY for performance risks: expensive work in render paths, repeated heavy computation,
blocking synchronous work, unnecessary sorting/filtering in hot code, N+1 style data fetching,
and avoidable large object creation inside loops.
${JSON_INSTRUCTION}`
  },
  {
    agent: "best-practices",
    category: "quality",
    confidence: 0.77,
    label: "best-practices",
    maxTokens: 850,
    system: `You are a senior reviewer focused on engineering best practices.
Analyze ONLY for maintainability and best-practice issues: missing validation, hidden assumptions,
unsafe suppression comments, poor separation of concerns, and patterns that teams usually regret later.
${JSON_INSTRUCTION}`
  },
  {
    agent: "quality",
    category: "quality",
    confidence: 0.75,
    label: "quality",
    maxTokens: 800,
    system: `You are a software architect performing a focused code quality review.
Analyze ONLY for maintainability issues: duplicated logic, confusing naming, tight coupling,
poor readability, and patterns that will be hard to test or extend.
${JSON_INSTRUCTION}`
  }
];

async function runAISecurityAgent(file: TriagedFile, spec: AgentSpec): Promise<SecurityIssue[]> {
  const text = await callAI(spec.system, buildCodeContext(file), spec.maxTokens);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
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

  return parsed.issues.map((issue) => ({
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
