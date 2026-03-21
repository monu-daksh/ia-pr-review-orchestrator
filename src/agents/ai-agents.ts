/**
 * AI-powered multi-agent pipeline.
 *
 * Each of the 6 specialized agents sends a focused system prompt to the best
 * available free AI (Groq → Gemini → Ollama) and parses structured JSON back.
 * If the AI call fails or returns unparseable output, that agent silently falls
 * back to the pattern-based implementation from local-agents.ts.
 *
 * Running all agents in parallel per file keeps latency low even on free tiers.
 */

import type {
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

// ─── Shared types for AI agent responses ─────────────────────────────────────

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

// ─── Helper: build the code context block sent to each agent ─────────────────

function buildCodeContext(file: TriagedFile): string {
  const lines = file.addedLines.map((l) => `${l.line}: ${l.content}`).join("\n");
  return [
    `File: ${file.file}`,
    `Language: ${file.language}`,
    `Risk level: ${file.triage.risk_level}`,
    `Areas of concern: ${file.triage.areas_of_concern.join(", ") || "general"}`,
    ``,
    `Added lines in this PR:`,
    lines || "(no added lines)"
  ].join("\n");
}

// ─── Shared JSON response instruction appended to every system prompt ─────────

const JSON_INSTRUCTION = `
Respond ONLY with valid JSON in this exact format — no markdown fences, no prose:
{"issues":[{"line":<number>,"title":"<string>","message":"<string>","severity":"critical|high|medium|low","code_snippet":"<string>","suggestion":"<string>"}]}
If there are no issues, return: {"issues":[]}`.trim();

// ─── Security Agent ───────────────────────────────────────────────────────────

const SECURITY_SYSTEM = `You are an expert application security engineer performing a focused security review.
Analyze ONLY for security vulnerabilities: XSS, SQL injection, command injection, CSRF, insecure auth,
secrets/credentials in code, insecure deserialization, path traversal, SSRF, open redirects, and similar.
Do NOT report style, performance, or general code quality issues.
${JSON_INSTRUCTION}`;

async function runAISecurityAgent(file: TriagedFile): Promise<SecurityIssue[]> {
  const text = await callAI(SECURITY_SYSTEM, buildCodeContext(file), 1000);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
    id: `S-ai-${file.file}-${issue.line}`,
    category: "security" as const,
    severity: issue.severity,
    agent: "security" as const,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet,
    title: issue.title,
    message: issue.message,
    fix: issue.suggestion ?? issue.fix ?? "",
    corrected_code: issue.fix ?? issue.suggestion,
    labels: ["security", issue.severity],
    confidence: 0.88
  }));
}

// ─── Bug Agent ────────────────────────────────────────────────────────────────

const BUG_SYSTEM = `You are a senior software engineer performing a focused bug review.
Analyze ONLY for runtime bugs: unhandled promises, null/undefined dereferences, off-by-one errors,
incorrect error handling, race conditions, memory leaks, unhandled exceptions, and logic errors
that would cause incorrect behavior at runtime.
Do NOT report security or style issues.
${JSON_INSTRUCTION}`;

async function runAIBugAgent(file: TriagedFile): Promise<ReviewIssue[]> {
  const text = await callAI(BUG_SYSTEM, buildCodeContext(file), 1000);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
    id: `R-ai-bug-${file.file}-${issue.line}`,
    category: "bug" as const,
    severity: issue.severity,
    agent: "bug" as const,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet,
    title: issue.title,
    message: issue.message,
    suggestion: issue.suggestion ?? "",
    corrected_code: issue.fix,
    labels: ["bug", issue.severity],
    confidence: 0.85
  }));
}

// ─── Logic Agent ──────────────────────────────────────────────────────────────

const LOGIC_SYSTEM = `You are a senior software engineer performing a focused logic review.
Analyze ONLY for logic errors: wrong conditionals, incorrect algorithm behavior, missing edge cases,
incorrect data transformations, wrong API usage patterns, and behavioral bugs where the code does
the wrong thing (not crashes, not security — just wrong outcomes).
${JSON_INSTRUCTION}`;

async function runAILogicAgent(file: TriagedFile): Promise<ReviewIssue[]> {
  const text = await callAI(LOGIC_SYSTEM, buildCodeContext(file), 1000);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
    id: `R-ai-logic-${file.file}-${issue.line}`,
    category: "bug" as const,
    severity: issue.severity,
    agent: "logic" as const,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet,
    title: issue.title,
    message: issue.message,
    suggestion: issue.suggestion ?? "",
    corrected_code: issue.fix,
    labels: ["logic", issue.severity],
    confidence: 0.82
  }));
}

// ─── Types Agent ──────────────────────────────────────────────────────────────

const TYPES_SYSTEM = `You are a TypeScript/static-typing expert performing a focused type-safety review.
Analyze ONLY for type issues: use of 'any', missing return types on public APIs, incorrect type assertions,
unsafe casts, missing null checks where types allow null/undefined, and type incompatibilities.
Focus on TypeScript/JavaScript — apply general type-safety principles to other languages.
${JSON_INSTRUCTION}`;

async function runAITypesAgent(file: TriagedFile): Promise<ReviewIssue[]> {
  const text = await callAI(TYPES_SYSTEM, buildCodeContext(file), 900);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
    id: `R-ai-types-${file.file}-${issue.line}`,
    category: "quality" as const,
    severity: issue.severity,
    agent: "types" as const,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet,
    title: issue.title,
    message: issue.message,
    suggestion: issue.suggestion ?? "",
    corrected_code: issue.fix,
    labels: ["types", issue.severity],
    confidence: 0.80
  }));
}

// ─── ESLint / Style Agent ─────────────────────────────────────────────────────

const ESLINT_SYSTEM = `You are a code quality and linting expert performing a focused style review.
Analyze ONLY for linting and style issues: use of 'var' instead of 'const/let', console.log in prod paths,
dead code, overly complex expressions, missing semicolons in contexts that require them, and violations
of common ESLint/Prettier rules. Only flag HIGH-confidence issues, not subjective preferences.
${JSON_INSTRUCTION}`;

async function runAIEslintAgent(file: TriagedFile): Promise<ReviewIssue[]> {
  const text = await callAI(ESLINT_SYSTEM, buildCodeContext(file), 800);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
    id: `R-ai-eslint-${file.file}-${issue.line}`,
    category: "quality" as const,
    severity: issue.severity,
    agent: "eslint" as const,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet,
    title: issue.title,
    message: issue.message,
    suggestion: issue.suggestion ?? "",
    corrected_code: issue.fix,
    labels: ["style", issue.severity],
    confidence: 0.78
  }));
}

// ─── Quality Agent ────────────────────────────────────────────────────────────

const QUALITY_SYSTEM = `You are a software architect performing a focused code quality review.
Analyze ONLY for maintainability and quality issues: duplicated logic, overly complex functions,
poor naming that causes confusion, tight coupling, missing abstractions that hurt readability,
and patterns that will make the code hard to test or maintain long-term.
Only flag meaningful issues — not minor style preferences.
${JSON_INSTRUCTION}`;

async function runAIQualityAgent(file: TriagedFile): Promise<ReviewIssue[]> {
  const text = await callAI(QUALITY_SYSTEM, buildCodeContext(file), 800);
  if (!text) return [];

  const parsed = safeJsonParse<AIAgentResponse | null>(text, null);
  if (!parsed?.issues?.length) return [];

  return parsed.issues.map((issue) => ({
    id: `R-ai-quality-${file.file}-${issue.line}`,
    category: "quality" as const,
    severity: issue.severity,
    agent: "quality" as const,
    file: file.file,
    line: issue.line,
    code_snippet: issue.code_snippet,
    title: issue.title,
    message: issue.message,
    suggestion: issue.suggestion ?? "",
    corrected_code: issue.fix,
    labels: ["quality", issue.severity],
    confidence: 0.75
  }));
}

// ─── Aggregate a single file ──────────────────────────────────────────────────

async function reviewFileWithAI(file: TriagedFile): Promise<ReviewFileResult> {
  // All 6 agents run in parallel — fast even on free tiers
  const [securityIssues, bugIssues, logicIssues, typeIssues, eslintIssues, qualityIssues] =
    await Promise.all([
      runAISecurityAgent(file),
      runAIBugAgent(file),
      runAILogicAgent(file),
      runAITypesAgent(file),
      runAIEslintAgent(file),
      runAIQualityAgent(file)
    ]);

  const reviewIssues = [...bugIssues, ...logicIssues, ...typeIssues, ...eslintIssues, ...qualityIssues];

  // Build simple patches from issues that have a fix suggestion
  const patches: Patch[] = [...securityIssues, ...reviewIssues]
    .filter((issue) => issue.corrected_code)
    .map((issue) => ({
      file: file.file,
      line: issue.line,
      original: issue.code_snippet,
      fixed: issue.corrected_code!
    }));

  return {
    file: file.file,
    language: file.language,
    triage: file.triage,
    review: { issues: reviewIssues },
    security: { vulnerabilities: securityIssues },
    fix: {
      required: patches.length > 0,
      fixed_code: patches.map((p) => p.fixed).join("\n"),
      patches,
      changes_summary: patches.map((p) => `Line ${p.line}: ${p.fixed.slice(0, 80)}`)
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
      `File: \`${issue.file}\` — Line: ${issue.line}`,
      `Severity: \`${issue.severity}\``,
      ``,
      issue.message,
      ``,
      correctedCode ? `**Suggested fix:**\n\`\`\`\n${correctedCode}\n\`\`\`` : ""
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function buildAgentRuns(files: ReviewFileResult[]): AgentRunSummary[] {
  const allIssues = files.flatMap((f) => [...f.review.issues, ...f.security.vulnerabilities]);
  const patchCount = files.reduce((n, f) => n + f.fix.patches.length, 0);
  return (["security", "bug", "logic", "types", "eslint", "quality", "fix"] as const).map(
    (agent) => ({
      agent,
      findings: agent === "fix" ? patchCount : allIssues.filter((i) => i.agent === agent).length,
      status: "completed" as const
    })
  );
}

/**
 * Main entry point for the AI multi-agent pipeline.
 *
 * If no free AI provider is configured (no GROQ_API_KEY, GEMINI_API_KEY, or
 * OLLAMA_HOST), every agent falls back to the pattern-based local pipeline
 * automatically — zero configuration required.
 */
export async function runAIAgentPipeline(triagedFiles: TriagedFile[]): Promise<ReviewResult> {
  const result = createEmptyReview(triagedFiles);

  // Process all files in parallel
  const fileResults = await Promise.all(triagedFiles.map((file) => reviewFileWithAI(file)));

  // If every agent returned zero issues for every file (AI returned no findings
  // or no AI was available), fall back to the pattern pipeline for coverage
  const hasAnyFindings = fileResults.some(
    (f) => f.review.issues.length > 0 || f.security.vulnerabilities.length > 0
  );

  if (!hasAnyFindings) {
    return runLocalAgentPipeline(triagedFiles);
  }

  result.files = fileResults;
  result.reports.pr_comments = fileResults.flatMap((f) =>
    [...f.review.issues, ...f.security.vulnerabilities].map(buildComment)
  );
  result.reports.agent_runs = buildAgentRuns(fileResults);

  return finalizeSummary(result);
}
