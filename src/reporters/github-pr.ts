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
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW"
};

const AGENT_LABEL: Record<string, string> = {
  security: "Security Agent",
  bug: "Bug Agent",
  logic: "Logic Agent",
  types: "Type Agent",
  eslint: "ESLint Agent",
  performance: "Performance Agent",
  "best-practices": "Best Practices Agent",
  quality: "Quality Agent",
  fix: "Fix Agent"
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
  if (changedLines.includes(comment.line)) return comment.line;

  let nearest = changedLines[0];
  let nearestDistance = Math.abs(comment.line - nearest);

  for (const line of changedLines.slice(1)) {
    const distance = Math.abs(comment.line - line);
    if (distance < nearestDistance) {
      nearest = line;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function toGithubComment(review: ReviewResult, comment: PRComment): GithubPRReviewReport["comments"][number] | null {
  const resolvedLine = resolveCommentLine(review, comment);
  if (resolvedLine == null) return null;

  const badge = SEVERITY_BADGE[comment.severity] ?? comment.severity.toUpperCase();
  const agent = AGENT_LABEL[comment.agent] ?? comment.agent;
  const lines: string[] = [`[${badge}] ${comment.title}`, `Agent: ${agent}`, ""];

  if (comment.issue) {
    lines.push(comment.issue, "");
  }

  if (comment.corrected_code?.trim()) {
    lines.push("Fix:", fenceBlock(comment.corrected_code), "");
  }

  return {
    path: comment.file,
    line: resolvedLine,
    severity: comment.severity,
    body: lines.join("\n")
  };
}

function buildSummaryComment(review: ReviewResult): string {
  const lines = [
    "## PR Review Orchestrator",
    "",
    `Decision: ${review.summary.final_decision}`,
    `Total issues: ${review.summary.total_issues}`,
    `Critical: ${review.summary.critical_count} | High: ${review.summary.high_count} | Medium: ${review.summary.medium_count} | Low: ${review.summary.low_count}`,
    ""
  ];

  if (review.reports.pr_comments.length === 0) {
    lines.push("No findings were generated.");
    return lines.join("\n");
  }

  lines.push("Findings:", "");

  for (const comment of review.reports.pr_comments.slice(0, 20)) {
    lines.push(`- ${comment.file}:${comment.line} [${comment.severity.toUpperCase()}] ${comment.title} (${AGENT_LABEL[comment.agent] ?? comment.agent})`);
  }

  return lines.join("\n");
}

export function buildGithubPRReviewReport(review: ReviewResult): GithubPRReviewReport {
  return {
    summary: review.summary,
    comments: review.reports.pr_comments
      .map((comment) => toGithubComment(review, comment))
      .filter((comment): comment is GithubPRReviewReport["comments"][number] => comment !== null),
    summary_comment: buildSummaryComment(review)
  };
}
