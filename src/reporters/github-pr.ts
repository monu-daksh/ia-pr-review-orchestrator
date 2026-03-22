import type { PRComment, ReviewResult } from "../types.js";

export interface GithubPRReviewReport {
  summary: ReviewResult["summary"];
  comments: Array<{
    path: string;
    line: number;
    severity: string;
    body: string;
  }>;
  summary_comment: string;
  summary_only_findings: number;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "🔵 LOW"
};

const DECISION_BADGE: Record<string, string> = {
  approve: "✅ Approve",
  request_changes: "🚫 Request Changes"
};

const AGENT_LABEL: Record<string, string> = {
  security: "🛡️ Security Agent",
  bug: "🐛 Bug Agent",
  logic: "🧠 Logic Agent",
  types: "📐 Type Agent",
  eslint: "🔍 ESLint Agent",
  performance: "⚡ Performance Agent",
  "best-practices": "✅ Best Practices Agent",
  quality: "🏗️ Quality Agent",
  fix: "🔧 Fix Agent"
};

function fenceBlock(code: string, lang = "ts"): string {
  const trimmed = code?.trim();
  if (!trimmed) return "";
  return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
}

function resolveCommentLine(review: ReviewResult, comment: PRComment): number | null {
  const file = review.files.find((entry) => entry.file === comment.file);
  const changedLines = file?.changed_lines?.filter((line) => Number.isFinite(line)) ?? [];

  if (changedLines.length === 0) return null;
  return changedLines.includes(comment.line) ? comment.line : null;
}

function toGithubComment(review: ReviewResult, comment: PRComment): GithubPRReviewReport["comments"][number] | null {
  const resolvedLine = resolveCommentLine(review, comment);
  if (resolvedLine == null) return null;

  const badge = SEVERITY_BADGE[comment.severity] ?? comment.severity.toUpperCase();
  const agent = AGENT_LABEL[comment.agent] ?? comment.agent;
  const lines: string[] = [
    `## [${badge}] ${comment.title}`,
    "",
    `| | |`,
    `|---|---|`,
    `| **Agent** | ${agent} |`,
    `| **File** | \`${comment.file}\` |`,
    `| **Line** | ${comment.line} |`,
    ""
  ];

  if (comment.issue) {
    lines.push("**🔎 Issue**", "", comment.issue, "");
  }

  if (comment.corrected_code?.trim()) {
    lines.push("**🔧 Suggested Fix**", "", fenceBlock(comment.corrected_code), "");
  }

  return {
    path: comment.file,
    line: resolvedLine,
    severity: comment.severity,
    body: lines.join("\n")
  };
}

function buildSummaryComment(review: ReviewResult): string {
  const inlineKeys = new Set(
    review.reports.pr_comments
      .map((comment) => toGithubComment(review, comment))
      .filter((comment): comment is GithubPRReviewReport["comments"][number] => comment !== null)
      .map((comment) => `${comment.path}:${comment.line}:${comment.body}`)
  );
  const decision = DECISION_BADGE[review.summary.final_decision] ?? review.summary.final_decision;
  const lines = [
    "## 🔍 PR Review Orchestrator",
    "",
    "| Decision | Issues | 🔴 Critical | 🟠 High | 🟡 Medium | 🔵 Low |",
    "|---|---|---|---|---|---|",
    `| ${decision} | ${review.summary.total_issues} | ${review.summary.critical_count} | ${review.summary.high_count} | ${review.summary.medium_count} | ${review.summary.low_count} |`,
    ""
  ];

  if (review.reports.pr_comments.length === 0) {
    lines.push("✅ No findings were generated.");
    return lines.join("\n");
  }

  lines.push("### 📋 Findings", "");

  for (const comment of review.reports.pr_comments.slice(0, 20)) {
    const badge = SEVERITY_BADGE[comment.severity] ?? comment.severity.toUpperCase();
    const agent = AGENT_LABEL[comment.agent] ?? comment.agent;
    const inlineVersion = toGithubComment(review, comment);
    const isInline = inlineVersion ? inlineKeys.has(`${inlineVersion.path}:${inlineVersion.line}:${inlineVersion.body}`) : false;

    lines.push(`<details>`);
    lines.push(`<summary><strong>[${badge}] ${comment.title}</strong> — ${agent} · <code>${comment.file}:${comment.line}</code></summary>`);
    lines.push("");
    lines.push(`**Issue:** ${comment.issue}`);
    lines.push("");
    lines.push(`**Placement:** ${isInline ? "📌 Inline comment" : "📄 Summary only"}`);

    if (comment.corrected_code?.trim()) {
      lines.push("");
      lines.push("**🔧 Suggested Fix:**");
      lines.push(fenceBlock(comment.corrected_code));
    }

    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

export function buildGithubPRReviewReport(review: ReviewResult): GithubPRReviewReport {
  const comments = review.reports.pr_comments
    .map((comment) => toGithubComment(review, comment))
    .filter((comment): comment is GithubPRReviewReport["comments"][number] => comment !== null);

  return {
    summary: review.summary,
    comments,
    summary_comment: buildSummaryComment(review),
    summary_only_findings: Math.max(0, review.reports.pr_comments.length - comments.length)
  };
}
