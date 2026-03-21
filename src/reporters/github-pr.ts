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
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "🔵 LOW"
};

const AGENT_LABEL: Record<string, string> = {
  security: "Security",
  bug: "Bug Detection",
  logic: "Logic",
  types: "Type Safety",
  eslint: "Code Style",
  quality: "Code Quality",
  fix: "Auto-Fix"
};

function fenceBlock(code: string, lang = "ts"): string {
  const trimmed = code?.trim();
  if (!trimmed) return "";
  return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
}

function toGithubComment(comment: PRComment): GithubPRReviewReport["comments"][number] {
  const badge = SEVERITY_BADGE[comment.severity] ?? comment.severity.toUpperCase();
  const agent = AGENT_LABEL[comment.labels.find((l) => Object.keys(AGENT_LABEL).includes(l)) ?? ""] ?? "Review";

  const lines: string[] = [
    `## [${badge}] ${comment.title}`,
    "",
    `**File:** \`${comment.file}\` | **Line:** ${comment.line} | **Agent:** ${agent}`,
    ""
  ];

  if (comment.issue) {
    lines.push("**Issue:**", comment.issue, "");
  }

  if (comment.code_snippet?.trim()) {
    lines.push("**Problematic code:**", fenceBlock(comment.code_snippet), "");
  }

  if (comment.corrected_code?.trim()) {
    lines.push("**Suggested fix:**", fenceBlock(comment.corrected_code), "");
  }

  if (comment.labels.length > 0) {
    lines.push(`**Labels:** ${comment.labels.map((l) => `\`${l}\``).join(" ")}`, "");
  }

  lines.push(`---`, `*Reviewed by [pr-review-orchestrator](https://github.com/your-org/pr-review-orchestrator) · agent: ${agent.toLowerCase()}*`);

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
