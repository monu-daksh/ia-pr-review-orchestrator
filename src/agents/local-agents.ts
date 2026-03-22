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

function createOutput(): AgentOutput {
  return {
    reviewIssues: [],
    securityIssues: [],
    patches: [],
    changesSummary: []
  };
}

function buildFixedCode(file: TriagedFile, patches: Patch[]): string {
  if (patches.length === 0) return "";

  const patchByLine = new Map<number, string>();
  for (const patch of patches) {
    patchByLine.set(patch.line, patch.fixed);
  }

  return file.addedLines.map((line) => patchByLine.get(line.line) ?? line.content).join("\n");
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
  const output = createOutput();

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
        message: "Unsanitized HTML can lead to XSS in frontend code.",
        fix: fixed,
        corrected_code: fixed,
        labels: ["security", "high", "xss"],
        confidence: 0.96
      });

      output.patches.push({ file: file.file, line: addedLine.line, original: addedLine.content, fixed });
      output.changesSummary.push(`Sanitized HTML rendering at line ${addedLine.line}.`);
    }

    if (/select .*where .*=\s*\$\{.+\}/i.test(addedLine.content)) {
      output.securityIssues.push({
        id: `S-${file.file}-${addedLine.line}-sql`,
        category: "security",
        severity: "critical",
        agent: "security",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Interpolated SQL query",
        message: "String interpolation in SQL can expose the query to injection.",
        fix: 'const sql = "select * from users where id = ?";',
        corrected_code: 'const sql = "select * from users where id = ?";',
        labels: ["security", "critical", "sql-injection"],
        confidence: 0.99
      });

      output.patches.push({
        file: file.file,
        line: addedLine.line,
        original: addedLine.content,
        fixed: '  const sql = "select * from users where id = ?";'
      });
      output.changesSummary.push(`Replaced interpolated SQL with a parameterized query at line ${addedLine.line}.`);
    }

    if (/db\.query\(sql\)/.test(addedLine.content)) {
      output.patches.push({
        file: file.file,
        line: addedLine.line,
        original: addedLine.content,
        fixed: "  const data = await db.query(sql, [id]);"
      });
      output.changesSummary.push(`Bound query parameters at line ${addedLine.line}.`);
    }
  }

  return output;
}

function runBugAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

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

function runLogicAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

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
        labels: ["logic", "high"],
        confidence: 0.93
      });
    }
  }

  return output;
}

function runTypesAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

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
        message: "Use unknown for caught errors in TypeScript-friendly code paths.",
        suggestion: "Annotate the caught error before narrowing it.",
        corrected_code: addedLine.content.replace(/\berror\b/, "error: unknown"),
        labels: ["types", "low"],
        confidence: 0.76
      });
    }
  }

  return output;
}

function runEslintAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of file.addedLines) {
    if (/console\.(log|error)\(/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-eslint-console`,
        category: "quality",
        severity: "low",
        agent: "eslint",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Console statement in application path",
        message: "This may violate strict lint rules in production repos.",
        suggestion: "Route the event to a logger helper instead.",
        corrected_code: addedLine.content.replace(/console\.(log|error)/, "logger.$1"),
        labels: ["eslint", "low"],
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
        suggestion: "Replace var with const or let.",
        corrected_code: addedLine.content.replace(/\bvar\b/, "const"),
        labels: ["eslint", "low"],
        confidence: 0.88
      });
    }
  }

  return output;
}

function runPerformanceAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of file.addedLines) {
    if (/\.sort\(/.test(addedLine.content) || /\.reverse\(/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-performance-sort`,
        category: "performance",
        severity: "medium",
        agent: "performance",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Potential expensive collection work in hot path",
        message: "Sorting or reversing inside frequently executed code can become expensive as data grows.",
        suggestion: "Precompute or memoize the transformed collection before rendering or repeated execution.",
        corrected_code: "const sortedItems = [...items].sort(compareItems);",
        labels: ["performance", "medium"],
        confidence: 0.74
      });
    }
  }

  return output;
}

function runBestPracticesAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of file.addedLines) {
    if (/@ts-ignore/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-best-practices-ignore`,
        category: "quality",
        severity: "medium",
        agent: "best-practices",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Type suppression added",
        message: "Suppressing type errors can hide real regressions and should usually be a last resort.",
        suggestion: "Prefer fixing the underlying type mismatch or narrowing the type safely.",
        corrected_code: "// Replace the suppression with a safer type guard or explicit type refinement.",
        labels: ["best-practices", "medium"],
        confidence: 0.83
      });
    }

    if (/==[^=]/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-best-practices-equality`,
        category: "quality",
        severity: "low",
        agent: "best-practices",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Loose equality check",
        message: "Loose equality can hide coercion bugs and is usually avoided in shared codebases.",
        suggestion: "Use strict equality unless coercion is explicitly intended.",
        corrected_code: addedLine.content.replace(/==/g, "===").replace(/!===$/, "!=="),
        labels: ["best-practices", "low"],
        confidence: 0.71
      });
    }
  }

  return output;
}

function runQualityAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

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

function mergeOutputs(file: TriagedFile, outputs: AgentOutput[]): ReviewFileResult {
  const reviewIssues = outputs.flatMap((output) => output.reviewIssues);
  const securityIssues = outputs.flatMap((output) => output.securityIssues);
  const patches = outputs.flatMap((output) => output.patches);
  const changesSummary = [...new Set(outputs.flatMap((output) => output.changesSummary))];

  return {
    file: file.file,
    language: file.language,
    triage: file.triage,
    review: { issues: reviewIssues },
    security: { vulnerabilities: securityIssues },
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
  return (["security", "bug", "logic", "types", "eslint", "performance", "best-practices", "quality", "fix"] as const).map((agent) => ({
    agent,
    findings: agent === "fix" ? patchCount : allIssues.filter((issue) => issue.agent === agent).length,
    status: "completed"
  }));
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
      runPerformanceAgent(file),
      runBestPracticesAgent(file),
      runQualityAgent(file)
    ])
  );

  result.reports.pr_comments = result.files.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map((issue) => buildComment(issue))
  );
  result.reports.agent_runs = buildAgentRuns(result.files);

  return finalizeSummary(result);
}
