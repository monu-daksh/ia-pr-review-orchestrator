import type {
  AgentRunSummary,
  Patch,
  PRComment,
  ReviewFileResult,
  ReviewIssue,
  ReviewResult,
  SecurityIssue,
  TriagedFile
} from "../types.js";
import { createEmptyReview, finalizeSummary } from "../core/schema.js";

interface AgentOutput {
  reviewIssues: ReviewIssue[];
  securityIssues: SecurityIssue[];
  patches: Patch[];
  changesSummary: string[];
}

function buildFixedCode(file: TriagedFile, patches: Patch[]): string {
  if (patches.length === 0) return "";

  const patchByLine = new Map<number, string>();
  for (const patch of patches) {
    patchByLine.set(patch.line, patch.fixed);
  }

  return file.addedLines
    .map((line) => patchByLine.get(line.line) ?? line.content)
    .join("\n");
}

function buildComment(issue: ReviewIssue | SecurityIssue): PRComment {
  const correctedCode =
    "corrected_code" in issue && issue.corrected_code ? issue.corrected_code :
    "fix" in issue ? issue.fix :
    issue.suggestion;

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
      `File: ${issue.file}`,
      `Line: ${issue.line}`,
      `Severity: ${issue.severity}`,
      `Issue: ${issue.title}`,
      `Details: ${issue.message}`,
      `Suggested fix: ${correctedCode}`
    ].join("\n")
  };
}

function runSecurityAgent(file: TriagedFile): AgentOutput {
  const output: AgentOutput = {
    reviewIssues: [],
    securityIssues: [],
    patches: [],
    changesSummary: []
  };

  for (const addedLine of file.addedLines) {
    if (/dangerouslySetInnerHTML/.test(addedLine.content)) {
      const fixed = addedLine.content.replace(
        /<div dangerouslySetInnerHTML=\{\{ __html: ([^}]+) \}\} \/>/,
        "<div>{sanitizeHtml($1)}</div>"
      );

      output.securityIssues.push({
        id: `S-${file.file}-${addedLine.line}-xss`,
        category: "security",
        severity: "high",
        agent: "security",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Unsafe HTML rendering",
        message: "Unsanitized HTML can lead to XSS in PR-reviewed frontend code.",
        fix: fixed,
        corrected_code: fixed,
        labels: ["security", "high", "xss"],
        confidence: 0.96
      });

      output.patches.push({
        file: file.file,
        line: addedLine.line,
        original: addedLine.content,
        fixed
      });
      output.changesSummary.push(`Sanitized HTML rendering at line ${addedLine.line}.`);
    }

    if (/select .*where .*=\s*\$\{.+\}/i.test(addedLine.content)) {
      const fixed = addedLine.content.replace(
        /`select \* from users where id = \$\{id\}`/i,
        "\"select * from users where id = ?\""
      );

      output.securityIssues.push({
        id: `S-${file.file}-${addedLine.line}-sql`,
        category: "security",
        severity: "critical",
        agent: "security",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Interpolated SQL query",
        message: "String interpolation in SQL can expose the route to injection.",
        fix: "const sql = \"select * from users where id = ?\";",
        corrected_code: "const sql = \"select * from users where id = ?\";",
        labels: ["security", "critical", "sql-injection"],
        confidence: 0.99
      });

      output.patches.push({
        file: file.file,
        line: addedLine.line,
        original: addedLine.content,
        fixed: "  const sql = \"select * from users where id = ?\";"
      });
      output.changesSummary.push(`Replaced interpolated SQL with a parameterized query template at line ${addedLine.line}.`);
    }

    if (/db\.query\(sql\)/.test(addedLine.content)) {
      output.patches.push({
        file: file.file,
        line: addedLine.line,
        original: addedLine.content,
        fixed: "  const data = await db.query(sql, [id]);"
      });
      output.changesSummary.push(`Bound route parameter to SQL query arguments at line ${addedLine.line}.`);
    }
  }

  return output;
}

function runBugAgent(file: TriagedFile): AgentOutput {
  const output: AgentOutput = {
    reviewIssues: [],
    securityIssues: [],
    patches: [],
    changesSummary: []
  };

  for (const addedLine of file.addedLines) {
    if (/fetch\(/.test(addedLine.content) && !/await /.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-fetch`,
        category: "bug",
        severity: "medium",
        agent: "bug",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Untracked async fetch call",
        message: "The new fetch call is not awaited or error-handled, so failures are silent.",
        suggestion: "Wrap the request in an async handler with await and try/catch.",
        corrected_code: "onClick={async () => { try { await fetch(`/api/users/${user.id}`); } catch (error) { console.error(error); } }}",
        labels: ["bug", "medium", "async"],
        confidence: 0.84
      });
    }
  }

  return output;
}

function runQualityAgent(file: TriagedFile): AgentOutput {
  const output: AgentOutput = {
    reviewIssues: [],
    securityIssues: [],
    patches: [],
    changesSummary: []
  };

  for (const addedLine of file.addedLines) {
    if (/\bany\b/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-typing`,
        category: "quality",
        severity: "low",
        agent: "quality",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Loose any typing",
        message: "Using any weakens review quality and hides type or lint regressions.",
        suggestion: "Replace any with a concrete type or a narrow interface.",
        corrected_code: addedLine.content.replace(/\bany\b/g, "unknown"),
        labels: ["quality", "low", "typing"],
        confidence: 0.9
      });
    }
  }

  return output;
}

function runLogicAgent(file: TriagedFile): AgentOutput {
  const output: AgentOutput = {
    reviewIssues: [],
    securityIssues: [],
    patches: [],
    changesSummary: []
  };

  for (const addedLine of file.addedLines) {
    if (/db\.query\(sql\)/.test(addedLine.content) && !/\[id\]/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-logic`,
        category: "bug",
        severity: "high",
        agent: "logic",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Query call misses bound parameters",
        message: "The query uses a SQL template but does not pass the route parameter to the DB driver.",
        suggestion: "Pass the route parameter as a bound argument in the query call.",
        corrected_code: "const data = await db.query(sql, [id]);",
        labels: ["bug", "high", "logic"],
        confidence: 0.93
      });
    }

    if (/onClick=\{\(\)\s*=>\s*fetch\(/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-handler`,
        category: "quality",
        severity: "medium",
        agent: "logic",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Inline side-effect handler",
        message: "Embedding async side effects directly in JSX makes logic harder to test and recover from.",
        suggestion: "Move the request into a named async handler.",
        corrected_code: "const handleRefresh = async () => { try { await fetch(`/api/users/${user.id}`); } catch (error) { console.error(error); } };",
        labels: ["quality", "medium", "logic"],
        confidence: 0.79
      });
    }
  }

  return output;
}

function runTypesAgent(file: TriagedFile): AgentOutput {
  const output: AgentOutput = {
    reviewIssues: [],
    securityIssues: [],
    patches: [],
    changesSummary: []
  };

  for (const addedLine of file.addedLines) {
    if (/\bcatch\s*\(\s*error\s*\)/.test(addedLine.content) && !/unknown/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-catch-type`,
        category: "quality",
        severity: "low",
        agent: "types",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Untyped caught error",
        message: "Use `unknown` for caught errors in TypeScript-friendly code paths.",
        suggestion: "Annotate the caught error before narrowing it.",
        corrected_code: addedLine.content.replace(/\berror\b/, "error: unknown"),
        labels: ["quality", "low", "types"],
        confidence: 0.76
      });
    }

    if (/sanitizeHtml\(/.test(addedLine.content) && file.language === "TypeScript") {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-import`,
        category: "quality",
        severity: "low",
        agent: "types",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "New helper may need import typing",
        message: "If `sanitizeHtml` is introduced, ensure the helper is imported and typed in the module.",
        suggestion: "Add a typed import for the sanitizer helper.",
        corrected_code: "import { sanitizeHtml } from \"../utils/sanitizeHtml\";",
        labels: ["quality", "low", "types"],
        confidence: 0.68
      });
    }
  }

  return output;
}

function runEslintAgent(file: TriagedFile): AgentOutput {
  const output: AgentOutput = {
    reviewIssues: [],
    securityIssues: [],
    patches: [],
    changesSummary: []
  };

  for (const addedLine of file.addedLines) {
    if (/console\.error\(/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-eslint-console`,
        category: "quality",
        severity: "low",
        agent: "eslint",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Console logging in application path",
        message: "This may violate strict ESLint rules in production repos.",
        suggestion: "Route the error to your logger or error boundary helper.",
        corrected_code: addedLine.content.replace("console.error", "logger.error"),
        labels: ["quality", "low", "eslint"],
        confidence: 0.72
      });
    }

    if (/\bvar\b/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-eslint-var`,
        category: "quality",
        severity: "low",
        agent: "eslint",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Use let/const instead of var",
        message: "Most repos enforce no-var in lint rules.",
        suggestion: "Replace `var` with `const` or `let`.",
        corrected_code: addedLine.content.replace(/\bvar\b/, "const"),
        labels: ["quality", "low", "eslint"],
        confidence: 0.88
      });
    }
  }

  return output;
}

function mergeOutputs(file: TriagedFile, outputs: AgentOutput[]): ReviewFileResult {
  const reviewIssues = outputs.flatMap((output) => output.reviewIssues);
  const securityIssues = outputs.flatMap((output) => output.securityIssues);
  const patches = outputs.flatMap((output) => output.patches);
  const changesSummary = [...new Set(outputs.flatMap((output) => output.changesSummary))];

  return {
    file: file.file,
    language: file.language,
    triage: file.triage,
    review: {
      issues: reviewIssues
    },
    security: {
      vulnerabilities: securityIssues
    },
    fix: {
      required: patches.length > 0,
      fixed_code: buildFixedCode(file, patches),
      patches,
      changes_summary: changesSummary
    }
  };
}

function buildAgentRuns(files: ReviewFileResult[]): AgentRunSummary[] {
  const allIssues = files.flatMap((file) => [...file.review.issues, ...file.security.vulnerabilities]);
  const patchCount = files.reduce((total, file) => total + file.fix.patches.length, 0);
  return ["security", "bug", "logic", "types", "eslint", "quality", "fix"].map((agent) => ({
    agent,
    findings: agent === "fix" ? patchCount : allIssues.filter((issue) => issue.agent === agent).length,
    status: "completed"
  })) as AgentRunSummary[];
}

export function runLocalAgentPipeline(triagedFiles: TriagedFile[]): ReviewResult {
  const result = createEmptyReview(triagedFiles);

  result.files = triagedFiles.map((file) =>
    mergeOutputs(file, [
      runSecurityAgent(file),
      runBugAgent(file),
      runLogicAgent(file),
      runTypesAgent(file),
      runEslintAgent(file),
      runQualityAgent(file)
    ])
  );

  result.reports.pr_comments = result.files.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map((issue) => buildComment(issue))
  );
  result.reports.agent_runs = buildAgentRuns(result.files);

  return finalizeSummary(result);
}
