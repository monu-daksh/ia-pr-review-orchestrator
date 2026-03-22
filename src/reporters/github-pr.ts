import type { PRComment, ReviewResult } from "../types.js";

export interface GithubPRReviewReport {
  summary: ReviewResult["summary"];
  comments: Array<{
    path: string;
    line: number;
    severity: string;
    body: string;
  }>;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW"
};

function fenceBlock(code: string, lang = "ts"): string {
  const trimmed = code?.trim();
  if (!trimmed) return "";
  return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
}

function toGithubComment(comment: PRComment): GithubPRReviewReport["comments"][number] {
  const badge = SEVERITY_BADGE[comment.severity] ?? comment.severity.toUpperCase();
  const lines: string[] = [`[${badge}] ${comment.title}`, ""];

  if (comment.issue) {
    lines.push(comment.issue, "");
  }

  if (comment.corrected_code?.trim()) {
    lines.push("Fix:", fenceBlock(comment.corrected_code), "");
  }

  return {
    path: comment.file,
    line: comment.line,
    severity: comment.severity,
    body: lines.join("\n")
  };
}

export function buildGithubPRReviewReport(review: ReviewResult): GithubPRReviewReport {
  return {
    summary: review.summary,
    comments: review.reports.pr_comments.map((comment) => toGithubComment(comment))
  };
}
