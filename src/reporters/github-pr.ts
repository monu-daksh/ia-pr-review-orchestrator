/**
 * ============================================================
 * FILE: src/reporters/github-pr.ts
 * PURPOSE: Converts a ReviewResult into a GitHub PR review report.
 *
 * TWO OUTPUT MODES:
 *
 *   1. BUNDLED (default — recommended)
 *      A single PR comment that groups ALL findings by agent.
 *      Every agent gets its own collapsible section so nothing is buried.
 *      Posted via: POST /repos/{owner}/{repo}/issues/{pr}/comments
 *
 *   2. INLINE (optional — for code-line annotation)
 *      Individual comments placed on specific diff lines.
 *      Only works for lines that appear in the diff.
 *      Posted via: POST /repos/{owner}/{repo}/pulls/{pr}/reviews
 *
 * WHY BUNDLED BY DEFAULT?
 *   Inline comments scatter findings across the diff. When 8 agents run,
 *   GitHub collapses all but the first few comments — users see "26 hidden
 *   conversations" and miss critical findings from later agents.
 *   A single bundled comment shows EVERYTHING in one place with full context.
 * ============================================================
 */

import type { PRComment, ReviewResult } from "../types.js";

// ─── Output Interface ────────────────────────────────────────────────────────

export interface GithubPRReviewReport {
  summary: ReviewResult["summary"];
  /** Bundled markdown comment — ONE comment with ALL findings grouped by agent */
  bundled_comment: string;
  /** Individual inline comments (optional, only for lines in the diff) */
  comments: Array<{
    path: string;
    line: number;
    severity: string;
    body: string;
  }>;
  /** Legacy field — same as bundled_comment, kept for backwards compatibility */
  summary_comment: string;
  summary_only_findings: number;
}

// ─── Badge & Label Maps ───────────────────────────────────────────────────────

const SEVERITY_BADGE: Record<string, string> = {
  critical: "🔴 CRITICAL",
  high:     "🟠 HIGH",
  medium:   "🟡 MEDIUM",
  low:      "🔵 LOW"
};

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high:     "🟠",
  medium:   "🟡",
  low:      "🔵"
};

const DECISION_BADGE: Record<string, string> = {
  approve:         "✅ Approved — No blocking issues found",
  request_changes: "🚫 Changes Requested — Blocking issues detected"
};

const AGENT_LABEL: Record<string, string> = {
  security:         "🛡️ Security",
  bug:              "🐛 Bug",
  logic:            "🧠 Logic",
  types:            "📐 Types",
  eslint:           "🔍 ESLint",
  performance:      "⚡ Performance",
  "best-practices": "✅ Best Practices",
  quality:          "🏗️ Quality",
  fix:              "🔧 Fix"
};

/** Short description of what each agent covers — shown in the agent table */
const AGENT_SCOPE: Record<string, string> = {
  security:         "secrets, tokens, XSS, unsafe HTML, injections",
  bug:              "crashes, null issues, async bugs, infinite loops",
  logic:            "wrong conditions, loose equality, validation flaws",
  types:            "any usage, missing types, unsafe typing",
  performance:      "heavy loops, blocking UI, re-renders, Math.random in JSX",
  eslint:           "console logs, unused variables, useless handlers",
  "best-practices": "hardcoded values, poor structure, missing error handling",
  quality:          "bad React patterns, side effects in render, large components"
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fenceBlock(code: string, lang = "ts"): string {
  const trimmed = code?.trim();
  return trimmed ? `\`\`\`${lang}\n${trimmed}\n\`\`\`` : "";
}

/** Resolves the line number for an inline comment — null if not on a changed line */
function resolveCommentLine(review: ReviewResult, comment: PRComment): number | null {
  const file = review.files.find((entry) => entry.file === comment.file);
  const changedLines = file?.changed_lines?.filter((line) => Number.isFinite(line)) ?? [];
  if (changedLines.length === 0) return null;
  return changedLines.includes(comment.line) ? comment.line : null;
}

// ─── Bundled Comment Builder ──────────────────────────────────────────────────

/**
 * Builds a single comprehensive PR comment with ALL findings grouped by agent.
 *
 * Structure:
 *   ## 🔍 PR Review Orchestrator
 *   Decision badge + overview table
 *
 *   ### 🤖 Agent Pipeline
 *   Table: agent | scope | finding count
 *
 *   ### 📋 Findings by Agent
 *   <details> per agent (auto-open for critical/high)
 *     Per-finding: severity badge, title, file:line, issue text, fix code block
 *   </details>
 */
function buildBundledComment(review: ReviewResult): string {
  const { summary } = review;
  const decision = DECISION_BADGE[summary.final_decision] ?? summary.final_decision;

  // Use flat normalized findings list (post-deduplication)
  const allFindings = review.reports.findings ?? [];

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push("## 🔍 PR Review Orchestrator");
  lines.push("");
  lines.push(`**${decision}**`);
  lines.push("");

  // ── Overview Table ───────────────────────────────────────────────────────
  lines.push("| Files | Issues | 🔴 Critical | 🟠 High | 🟡 Medium | 🔵 Low |");
  lines.push("|---|---|---|---|---|---|");
  lines.push(
    `| ${summary.total_files} | **${summary.total_issues}** | ${summary.critical_count} | ${summary.high_count} | ${summary.medium_count} | ${summary.low_count} |`
  );
  lines.push("");

  // ── Agent Pipeline Table ─────────────────────────────────────────────────
  if (review.reports.agent_runs?.length) {
    lines.push("### 🤖 Agent Pipeline");
    lines.push("");
    lines.push("| Agent | Scope | Findings |");
    lines.push("|---|---|---|");

    for (const run of review.reports.agent_runs) {
      if (run.agent === "fix") continue; // skip the synthetic fix agent
      const label  = AGENT_LABEL[run.agent] ?? run.agent;
      const scope  = AGENT_SCOPE[run.agent] ?? "—";
      const agentFindings = allFindings.filter((f) => f.agent === run.agent);

      // Build a compact severity string like "🔴🔴🟠🟡🔵"
      const severityDots = agentFindings
        .map((f) => SEVERITY_EMOJI[f.severity] ?? "⚪")
        .join("");

      const countStr = run.findings > 0
        ? `**${run.findings}** ${severityDots}`
        : "✓ clean";

      lines.push(`| ${label} | ${scope} | ${countStr} |`);
    }
    lines.push("");
  }

  // ── No findings state ─────────────────────────────────────────────────────
  if (allFindings.length === 0) {
    lines.push("---");
    lines.push("");
    lines.push("✅ All agents completed — no issues detected.");
    return lines.join("\n");
  }

  // ── Findings by Agent ─────────────────────────────────────────────────────
  lines.push("### 📋 Findings by Agent");
  lines.push("");

  // Get unique agents that have findings, in a stable order
  const agentOrder = ["security", "bug", "logic", "types", "performance", "eslint", "best-practices", "quality"] as const;

  for (const agentKey of agentOrder) {
    const agentFindings = allFindings.filter((f) => f.agent === agentKey);
    if (agentFindings.length === 0) continue;

    const label  = AGENT_LABEL[agentKey] ?? agentKey;
    const hasCriticalOrHigh = agentFindings.some((f) => f.severity === "critical" || f.severity === "high");

    // Severity breakdown for the section header
    const severityBreakdown = (["critical", "high", "medium", "low"] as const)
      .map((sev) => {
        const count = agentFindings.filter((f) => f.severity === sev).length;
        return count > 0 ? `${SEVERITY_EMOJI[sev]} ${count}` : null;
      })
      .filter(Boolean)
      .join("  ");

    // Auto-open critical/high sections so blockers are immediately visible
    const openAttr = hasCriticalOrHigh ? " open" : "";

    lines.push(`<details${openAttr}>`);
    lines.push(`<summary><strong>${label} — ${agentFindings.length} issue${agentFindings.length !== 1 ? "s" : ""}</strong>  ${severityBreakdown}</summary>`);
    lines.push("");

    for (const finding of agentFindings) {
      const badge = SEVERITY_BADGE[finding.severity] ?? finding.severity.toUpperCase();

      lines.push("---");
      lines.push("");
      lines.push(`**[${badge}] ${finding.title}**`);
      lines.push(`> \`${finding.file}\` — Line ${finding.line} · confidence ${Math.round((finding.confidence ?? 0) * 100)}%`);
      lines.push("");
      lines.push(finding.issue);
      lines.push("");

      if (finding.code_snippet?.trim()) {
        lines.push("**Problem code:**");
        lines.push(fenceBlock(finding.code_snippet));
        lines.push("");
      }

      if (finding.corrected_code?.trim()) {
        lines.push("**🔧 Fix:**");
        lines.push(fenceBlock(finding.corrected_code));
        lines.push("");
      }
    }

    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Inline Comment Builder ────────────────────────────────────────────────────

/**
 * Converts a PRComment into a GitHub inline review comment.
 * Returns null if the finding's line isn't in the diff (can't be placed inline).
 */
function toGithubInlineComment(
  review: ReviewResult,
  comment: PRComment
): GithubPRReviewReport["comments"][number] | null {
  const resolvedLine = resolveCommentLine(review, comment);
  if (resolvedLine == null) return null;

  const badge = SEVERITY_BADGE[comment.severity] ?? comment.severity.toUpperCase();
  const agent = AGENT_LABEL[comment.agent]  ?? comment.agent;

  const bodyLines: string[] = [
    `**[${badge}] ${comment.title}**`,
    "",
    `| | |`,
    `|---|---|`,
    `| **Agent** | ${agent} |`,
    `| **File**  | \`${comment.file}\` |`,
    `| **Line**  | ${comment.line} |`,
    ""
  ];

  if (comment.issue) {
    bodyLines.push("**🔎 Issue**", "", comment.issue, "");
  }

  if (comment.corrected_code?.trim()) {
    bodyLines.push("**🔧 Fix**", "", fenceBlock(comment.corrected_code), "");
  }

  return {
    path:     comment.file,
    line:     resolvedLine,
    severity: comment.severity,
    body:     bodyLines.join("\n")
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Converts a ReviewResult into a GithubPRReviewReport.
 *
 * PRIMARY OUTPUT: `bundled_comment`
 *   A single markdown comment with ALL findings grouped by agent.
 *   Post this to the PR using the Issues Comments API so it appears as
 *   one consolidated review instead of many scattered inline comments.
 *
 * SECONDARY OUTPUT: `comments`
 *   Individual inline comments for code-line annotation.
 *   Optional — only useful if you want inline diff highlighting in addition.
 */
export function buildGithubPRReviewReport(review: ReviewResult): GithubPRReviewReport {
  const bundled = buildBundledComment(review);

  const inlineComments = review.reports.pr_comments
    .map((comment) => toGithubInlineComment(review, comment))
    .filter((c): c is GithubPRReviewReport["comments"][number] => c !== null);

  return {
    summary:                review.summary,
    bundled_comment:        bundled,
    comments:               inlineComments,
    summary_comment:        bundled, // backwards compat alias
    summary_only_findings:  Math.max(0, review.reports.pr_comments.length - inlineComments.length)
  };
}
