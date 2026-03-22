/**
 * ============================================================
 * FILE: src/reporters/github-pr.ts
 * PURPOSE: Converts a ReviewResult into a GitHub PR review report.
 *          Formats findings as inline PR comments and a summary comment
 *          ready to be posted to the GitHub API.
 *
 * OUTPUT: GithubPRReviewReport with:
 *   comments        → inline comments for specific file:line locations
 *                     (only for lines that appear in the diff — GitHub requires this)
 *   summary_comment → full markdown summary comment for the PR thread
 *                     (includes ALL findings, even those not on changed lines)
 *   summary_only_findings → count of findings that can only go in summary
 *                            (not on a changed line — can't be placed inline)
 *
 * HOW GITHUB PR COMMENTS WORK:
 *   Inline comments can only be placed on lines in the diff (changed lines).
 *   A finding on line 10 can only be an inline comment if line 10 appears
 *   in the PR's changed_lines. Otherwise it goes in the summary comment only.
 *
 * FORMATTING:
 *   Uses markdown with emoji badges for severity and agent labels.
 *   Summary shows findings in <details> collapsible blocks for readability.
 * ============================================================
 */

import type { PRComment, ReviewResult } from "../types.js";

/**
 * The output format returned by buildGithubPRReviewReport().
 * This matches what the GitHub REST API expects for PR review comments.
 */
export interface GithubPRReviewReport {
  summary: ReviewResult["summary"];  // Overall counts (total files, issues, decision)
  comments: Array<{
    path: string;     // File path (for GitHub API: "src/foo.ts")
    line: number;     // Line number in the diff (must be a changed line)
    severity: string; // Severity level for sorting/filtering
    body: string;     // Formatted markdown comment body
  }>;
  summary_comment: string;        // Full markdown summary for the PR thread
  summary_only_findings: number;  // How many findings couldn't be placed inline
}

// ─── Badge Lookup Tables ──────────────────────────────────────────────────────

/**
 * Visual severity badges used in PR comments.
 * The colored circles make it easy to scan findings by severity at a glance.
 */
const SEVERITY_BADGE: Record<string, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "🔵 LOW"
};

/**
 * Decision badges shown in the summary header.
 * Green checkmark = approve, red stop = request changes.
 */
const DECISION_BADGE: Record<string, string> = {
  approve: "✅ Approve",
  request_changes: "🚫 Request Changes"
};

/**
 * Agent labels with emoji for the PR comment table.
 * Each emoji visually represents what the agent specializes in.
 */
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

// ─── Formatting Helpers ───────────────────────────────────────────────────────

/**
 * Wraps code in a markdown fenced code block.
 * Returns empty string if code is empty/whitespace.
 *
 * @param code - The code to wrap
 * @param lang - Language for syntax highlighting (default: "ts")
 * @returns Markdown fenced code block string
 */
function fenceBlock(code: string, lang = "ts"): string {
  const trimmed = code?.trim();
  if (!trimmed) return ""; // No code → no block
  return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
}

/**
 * Resolves which line number to use for an inline PR comment.
 *
 * GitHub only allows inline comments on lines that appear in the diff
 * (i.e., lines in changed_lines). If the finding's line isn't in the diff,
 * returns null — the finding will only appear in the summary comment.
 *
 * @param review  - The full ReviewResult (needed to check changed_lines per file)
 * @param comment - The PR comment with the reported line number
 * @returns The line number for inline placement, or null if not on a changed line
 */
function resolveCommentLine(review: ReviewResult, comment: PRComment): number | null {
  // Find the file's ReviewFileResult to get its changed_lines list
  const file = review.files.find((entry) => entry.file === comment.file);
  // Get changed lines — filter out any non-finite values for safety
  const changedLines = file?.changed_lines?.filter((line) => Number.isFinite(line)) ?? [];

  if (changedLines.length === 0) return null; // No changed lines in this file → can't place inline

  // Only place inline if the reported line was actually changed in this PR
  return changedLines.includes(comment.line) ? comment.line : null;
}

/**
 * Converts a PRComment into a GitHub PR review comment object.
 * Returns null if the comment's line isn't in the diff (can't be inline).
 *
 * The comment body uses a table format for metadata and code blocks for fixes:
 *   ## [🔴 CRITICAL] Hardcoded Secret
 *   | Agent | 🛡️ Security Agent |
 *   | File  | `src/auth.ts`      |
 *   | Line  | 42                 |
 *   **🔎 Issue**
 *   <explanation text>
 *   **🔧 Suggested Fix**
 *   ```ts
 *   <fixed code>
 *   ```
 *
 * @param review  - Full ReviewResult for line resolution
 * @param comment - The PR comment to format
 * @returns Formatted comment object, or null if can't be placed inline
 */
function toGithubComment(review: ReviewResult, comment: PRComment): GithubPRReviewReport["comments"][number] | null {
  const resolvedLine = resolveCommentLine(review, comment);
  if (resolvedLine == null) return null; // Can't place inline — will be in summary only

  const badge = SEVERITY_BADGE[comment.severity] ?? comment.severity.toUpperCase(); // e.g., "🔴 CRITICAL"
  const agent = AGENT_LABEL[comment.agent] ?? comment.agent;                        // e.g., "🛡️ Security Agent"

  const lines: string[] = [
    `## [${badge}] ${comment.title}`, // Severity badge + issue title
    "",
    `| | |`,                          // Table header (empty columns for layout)
    `|---|---|`,
    `| **Agent** | ${agent} |`,       // Which agent found this
    `| **File** | \`${comment.file}\` |`,
    `| **Line** | ${comment.line} |`,
    ""
  ];

  // Include the issue explanation
  if (comment.issue) {
    lines.push("**🔎 Issue**", "", comment.issue, "");
  }

  // Include the code fix if available
  if (comment.corrected_code?.trim()) {
    lines.push("**🔧 Suggested Fix**", "", fenceBlock(comment.corrected_code), "");
  }

  return {
    path: comment.file,         // File path for GitHub API
    line: resolvedLine,         // Line number for inline placement
    severity: comment.severity, // For sorting/filtering by consumers
    body: lines.join("\n")      // Full formatted markdown body
  };
}

// ─── Summary Comment Builder ──────────────────────────────────────────────────

/**
 * Builds the full summary comment posted to the PR thread.
 * This is always posted (unlike inline comments which only go on changed lines).
 *
 * Format:
 *   ## 🔍 PR Review Orchestrator
 *   | Decision | Issues | Critical | High | Medium | Low |
 *   (table row with counts)
 *
 *   ### 📋 Findings
 *   <details> (collapsible per finding, up to 20)
 *   <summary>[severity badge] title — agent · file:line</summary>
 *   Issue: explanation
 *   Placement: 📌 Inline / 📄 Summary only
 *   Suggested Fix: code block
 *   </details>
 *
 * @param review - The full ReviewResult
 * @returns Markdown string for the GitHub PR summary comment
 */
function buildSummaryComment(review: ReviewResult): string {
  // Pre-compute which comments can be placed inline (for "Placement" indicator)
  const inlineKeys = new Set(
    review.reports.pr_comments
      .map((comment) => toGithubComment(review, comment))
      .filter((comment): comment is GithubPRReviewReport["comments"][number] => comment !== null)
      .map((comment) => `${comment.path}:${comment.line}:${comment.body}`) // Unique key per inline comment
  );

  const decision = DECISION_BADGE[review.summary.final_decision] ?? review.summary.final_decision;

  const lines = [
    "## 🔍 PR Review Orchestrator",
    "",
    // Summary table with decision and severity counts
    "| Decision | Issues | 🔴 Critical | 🟠 High | 🟡 Medium | 🔵 Low |",
    "|---|---|---|---|---|---|",
    `| ${decision} | ${review.summary.total_issues} | ${review.summary.critical_count} | ${review.summary.high_count} | ${review.summary.medium_count} | ${review.summary.low_count} |`,
    ""
  ];

  // If no findings at all, show a clean "all good" message
  if (review.reports.pr_comments.length === 0) {
    lines.push("✅ No findings were generated.");
    return lines.join("\n");
  }

  lines.push("### 📋 Findings", "");

  // Show up to 20 findings in collapsible <details> blocks
  // (More than 20 findings would make the summary too long)
  for (const comment of review.reports.pr_comments.slice(0, 20)) {
    const badge = SEVERITY_BADGE[comment.severity] ?? comment.severity.toUpperCase();
    const agent = AGENT_LABEL[comment.agent] ?? comment.agent;

    // Determine if this specific comment can be placed inline
    const inlineVersion = toGithubComment(review, comment);
    const isInline = inlineVersion ? inlineKeys.has(`${inlineVersion.path}:${inlineVersion.line}:${inlineVersion.body}`) : false;

    // Collapsible block — click to expand details
    lines.push(`<details>`);
    lines.push(`<summary><strong>[${badge}] ${comment.title}</strong> — ${agent} · <code>${comment.file}:${comment.line}</code></summary>`);
    lines.push("");
    lines.push(`**Issue:** ${comment.issue}`);
    lines.push("");
    // Show whether this finding will also appear as an inline comment
    lines.push(`**Placement:** ${isInline ? "📌 Inline comment" : "📄 Summary only"}`);

    // Show the fix code if available
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Converts a ReviewResult into a GithubPRReviewReport.
 * This is the main function used by the CLI when --format github-pr is set,
 * and by GitHub Actions workflows to post reviews.
 *
 * @param review - The complete ReviewResult from reviewDiff()
 * @returns GithubPRReviewReport with inline comments and summary comment
 */
export function buildGithubPRReviewReport(review: ReviewResult): GithubPRReviewReport {
  // Convert all PR comments to inline GitHub comments (null = not on a changed line)
  const comments = review.reports.pr_comments
    .map((comment) => toGithubComment(review, comment))
    .filter((comment): comment is GithubPRReviewReport["comments"][number] => comment !== null); // Remove nulls

  return {
    summary: review.summary,
    comments,                                  // Only inline-placeable comments
    summary_comment: buildSummaryComment(review), // Full summary with ALL findings
    // How many findings couldn't be placed inline (informational — for logging)
    summary_only_findings: Math.max(0, review.reports.pr_comments.length - comments.length)
  };
}
