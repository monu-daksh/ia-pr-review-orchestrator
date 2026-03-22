import type { FileFindingSummary, NormalizedFinding, PRComment, ReviewIssue, ReviewResult, SecurityIssue } from "../types.js";

const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
} as const;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function canonicalTopic(issue: ReviewIssue | SecurityIssue): string {
  const text = normalizeText(`${issue.title} ${issue.message} ${issue.code_snippet}`);

  if (text.includes("dangerouslysetinnerhtml") || text.includes("xss")) return "xss";
  if (
    text.includes("secret") ||
    text.includes("api key") ||
    text.includes("token") ||
    text.includes("password") ||
    text.includes("private key")
  ) return "secret-exposure";
  if (text.includes("console") && (text.includes("secret") || text.includes("token") || text.includes("password"))) {
    return "secret-exposure";
  }
  if (text.includes("sql") || text.includes("query") && text.includes("injection")) return "sql-injection";
  if (text.includes("expensive") || text.includes("render") || text.includes("computation")) return "performance-hot-path";
  if (text.includes("any") || text.includes("type")) return "type-safety";
  if (text.includes("console")) return "console-logging";
  if (text.includes("redirect")) return "redirect";

  return normalizeText(issue.title);
}

function shouldReplaceIssue(current: ReviewIssue | SecurityIssue, existing: ReviewIssue | SecurityIssue): boolean {
  const currentRank = SEVERITY_RANK[current.severity];
  const existingRank = SEVERITY_RANK[existing.severity];
  const currentSecurity = current.category === "security" ? 1 : 0;
  const existingSecurity = existing.category === "security" ? 1 : 0;
  const currentHasFix = getCorrectedCode(current) ? 1 : 0;
  const existingHasFix = getCorrectedCode(existing) ? 1 : 0;

  return (
    currentRank > existingRank ||
    (currentRank === existingRank && currentSecurity > existingSecurity) ||
    (currentRank === existingRank && currentSecurity === existingSecurity && currentHasFix > existingHasFix) ||
    (
      currentRank === existingRank &&
      currentSecurity === existingSecurity &&
      currentHasFix === existingHasFix &&
      current.confidence > existing.confidence
    )
  );
}

function dedupeIssues(issues: Array<ReviewIssue | SecurityIssue>): Array<ReviewIssue | SecurityIssue> {
  const chosen: Array<ReviewIssue | SecurityIssue> = [];

  for (const issue of issues) {
    const topic = canonicalTopic(issue);
    const snippet = normalizeText(issue.code_snippet);

    const existingIndex = chosen.findIndex((existing) => {
      const sameFile = existing.file === issue.file;
      const sameTopic = canonicalTopic(existing) === topic;
      const closeLine = Math.abs(existing.line - issue.line) <= 2;
      const sameSnippet = normalizeText(existing.code_snippet) === snippet;
      return sameFile && sameTopic && (sameSnippet || closeLine);
    });

    if (existingIndex === -1) {
      chosen.push(issue);
      continue;
    }

    if (shouldReplaceIssue(issue, chosen[existingIndex])) {
      chosen[existingIndex] = issue;
    }
  }

  return chosen.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

function dedupeReviewResult(reviewResult: ReviewResult): void {
  for (const file of reviewResult.files) {
    const deduped = dedupeIssues([...file.review.issues, ...file.security.vulnerabilities]);
    file.review.issues = deduped.filter((issue): issue is ReviewIssue => issue.category !== "security");
    file.security.vulnerabilities = deduped.filter((issue): issue is SecurityIssue => issue.category === "security");
  }
}

function getCorrectedCode(issue: ReviewIssue | SecurityIssue): string | undefined {
  if ("corrected_code" in issue && issue.corrected_code) return issue.corrected_code;
  if ("fix" in issue && issue.fix) return issue.fix;
  if ("suggestion" in issue && issue.suggestion) return issue.suggestion;
  return undefined;
}

function toFinding(issue: ReviewIssue | SecurityIssue): NormalizedFinding {
  return {
    id: issue.id,
    file: issue.file,
    line: issue.line,
    agent: issue.agent,
    category: issue.category,
    severity: issue.severity,
    title: issue.title,
    issue: issue.message,
    code_snippet: issue.code_snippet,
    corrected_code: getCorrectedCode(issue),
    labels: issue.labels,
    confidence: issue.confidence
  };
}

function toComment(issue: ReviewIssue | SecurityIssue): PRComment {
  const correctedCode = getCorrectedCode(issue) ?? "";

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
    body: ""
  };
}

function buildFileSummaries(reviewResult: ReviewResult): FileFindingSummary[] {
  return reviewResult.files.map((file) => {
    const findings = [...file.review.issues, ...file.security.vulnerabilities];

    return {
      file: file.file,
      total_findings: findings.length,
      critical_count: findings.filter((finding) => finding.severity === "critical").length,
      high_count: findings.filter((finding) => finding.severity === "high").length,
      medium_count: findings.filter((finding) => finding.severity === "medium").length,
      low_count: findings.filter((finding) => finding.severity === "low").length
    };
  });
}

function buildMarkdownSummary(reviewResult: ReviewResult): string {
  const lines = [
    "# PR Review Summary",
    "",
    `Decision: **${reviewResult.summary.final_decision}**`,
    `Files reviewed: **${reviewResult.summary.total_files}**`,
    `Total findings: **${reviewResult.summary.total_issues}**`,
    `Critical: **${reviewResult.summary.critical_count}** | High: **${reviewResult.summary.high_count}** | Medium: **${reviewResult.summary.medium_count}** | Low: **${reviewResult.summary.low_count}**`,
    ""
  ];

  const filesWithFindings = reviewResult.reports.files.filter((entry) => entry.total_findings > 0);
  if (filesWithFindings.length === 0) {
    lines.push("No findings detected in the reviewed diff.");
    return lines.join("\n");
  }

  lines.push("## Files", "");

  for (const file of filesWithFindings) {
    lines.push(
      `- \`${file.file}\`: ${file.total_findings} finding(s) [critical: ${file.critical_count}, high: ${file.high_count}, medium: ${file.medium_count}, low: ${file.low_count}]`
    );
  }

  return lines.join("\n");
}

function hydrateDerivedReports(reviewResult: ReviewResult): void {
  reviewResult.reports.pr_comments = reviewResult.files.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map((issue) => toComment(issue))
  );
  reviewResult.reports.findings = reviewResult.files.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map((issue) => toFinding(issue))
  );
  reviewResult.reports.files = buildFileSummaries(reviewResult);
  reviewResult.reports.markdown_summary = buildMarkdownSummary(reviewResult);
}

export function createEmptyReview(files: Array<{ file: string; language: string }>): ReviewResult {
  return {
    files: files.map((file) => ({
      file: file.file,
      language: file.language,
      triage: {
        needs_review: true,
        risk_level: "low",
        areas_of_concern: [],
        verdict: ""
      },
      review: {
        issues: []
      },
      security: {
        vulnerabilities: []
      },
      fix: {
        required: false,
        fixed_code: "",
        patches: [],
        changes_summary: []
      }
    })),
    summary: {
      total_files: files.length,
      total_issues: 0,
      critical_count: 0,
      high_count: 0,
      medium_count: 0,
      low_count: 0,
      final_decision: "approve"
    },
    reports: {
      pr_comments: [],
      agent_runs: [],
      findings: [],
      files: [],
      markdown_summary: ""
    }
  };
}

export function finalizeSummary(reviewResult: ReviewResult): ReviewResult {
  dedupeReviewResult(reviewResult);

  let totalIssues = 0;
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const file of reviewResult.files) {
    const allIssues = [...file.review.issues, ...file.security.vulnerabilities];
    totalIssues += allIssues.length;
    for (const issue of allIssues) {
      if (issue.severity === "critical") critical += 1;
      if (issue.severity === "high") high += 1;
      if (issue.severity === "medium") medium += 1;
      if (issue.severity === "low") low += 1;
    }
  }

  reviewResult.summary.total_files = reviewResult.files.length;
  reviewResult.summary.total_issues = totalIssues;
  reviewResult.summary.critical_count = critical;
  reviewResult.summary.high_count = high;
  reviewResult.summary.medium_count = medium;
  reviewResult.summary.low_count = low;
  reviewResult.summary.final_decision =
    critical > 0 || high > 0 ? "request_changes" : "approve";

  hydrateDerivedReports(reviewResult);

  return reviewResult;
}

