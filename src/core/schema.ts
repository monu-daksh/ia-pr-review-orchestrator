/**
 * ============================================================
 * FILE: src/core/schema.ts
 * PURPOSE: Post-processing logic that runs AFTER the AI or local agents
 *          return their raw findings. Responsible for:
 *
 *   1. DEDUPLICATION  — Removes duplicate findings that multiple agents
 *      may report for the same issue (e.g., security agent + eslint agent
 *      both report the same console.log). Uses semantic canonicalization
 *      to match issues by topic, not just exact text.
 *
 *   2. SEVERITY RANKING — When two agents report the same issue, keeps
 *      the version with the highest severity, then prefers security category,
 *      then prefers whichever has a code fix, then prefers higher confidence.
 *
 *   3. COUNTING & DECISION — Counts findings by severity and sets
 *      final_decision to "request_changes" if any critical or high finding exists.
 *
 *   4. REPORT HYDRATION — Builds the derived report fields:
 *      pr_comments, findings (flat list), files (per-file summary), markdown_summary
 *
 * KEY DESIGN: Agents run independently and may overlap. This module is the
 * single place where overlaps are resolved and the final review is assembled.
 * ============================================================
 */

import type { FileFindingSummary, NormalizedFinding, PRComment, ReviewIssue, ReviewResult, SecurityIssue } from "../types.js";

/**
 * Numeric rank for each severity level.
 * Used to compare two findings and decide which to keep during deduplication.
 * Higher number = more severe = should be kept.
 */
const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
} as const;

// ─── Canonical Topic Detection ────────────────────────────────────────────────

/**
 * Normalizes arbitrary text for comparison.
 * Lowercases and collapses non-alphanumeric characters to spaces.
 * Used in canonical topic matching so "XSS Attack" and "xss-attack" match.
 */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Maps an issue to its canonical semantic topic.
 * Two issues with the same canonical topic are considered duplicates
 * (when they are also in the same file and near the same line).
 *
 * Examples:
 *   "dangerouslySetInnerHTML detected" → "xss"
 *   "API_KEY exposed in code"          → "secret-exposure"
 *   "SQL string interpolation"         → "sql-injection"
 *   "console.log in render"            → "console-logging"
 *
 * Falls back to the normalized issue title for topics not explicitly recognized.
 */
function canonicalTopic(issue: ReviewIssue | SecurityIssue): string {
  const text = normalizeText(`${issue.title} ${issue.message} ${issue.code_snippet}`);

  // XSS via dangerouslySetInnerHTML or explicit xss mention
  if (text.includes("dangerouslysetinnerhtml") || text.includes("xss")) return "xss";

  // Secret/credential exposure in code
  if (
    text.includes("secret") ||
    text.includes("api key") ||
    text.includes("token") ||
    text.includes("password") ||
    text.includes("private key")
  ) return "secret-exposure";

  // Sensitive data logged to console — also maps to secret-exposure
  if (text.includes("console") && (text.includes("secret") || text.includes("token") || text.includes("password"))) {
    return "secret-exposure";
  }

  // SQL injection via string interpolation
  if (text.includes("sql") || text.includes("query") && text.includes("injection")) return "sql-injection";

  // Performance issue from expensive computation in a hot path
  if (text.includes("expensive") || text.includes("render") || text.includes("computation")) return "performance-hot-path";

  // TypeScript type safety issues (any usage, missing types)
  if (text.includes("any") || text.includes("type")) return "type-safety";

  // Console statements left in code
  if (text.includes("console")) return "console-logging";

  // Open redirect vulnerability
  if (text.includes("redirect")) return "redirect";

  // Default: use the normalized title as the topic
  return normalizeText(issue.title);
}

// ─── Deduplication Logic ──────────────────────────────────────────────────────

/**
 * Decides whether a new issue should REPLACE an existing one with the same topic.
 *
 * Priority order (descending):
 *   1. Higher severity wins
 *   2. Security category wins over non-security at same severity
 *   3. Issue with a code fix wins over one without
 *   4. Higher confidence score wins when everything else is equal
 */
function shouldReplaceIssue(current: ReviewIssue | SecurityIssue, existing: ReviewIssue | SecurityIssue): boolean {
  const currentRank = SEVERITY_RANK[current.severity];
  const existingRank = SEVERITY_RANK[existing.severity];
  const currentSecurity = current.category === "security" ? 1 : 0;   // 1 if security, 0 otherwise
  const existingSecurity = existing.category === "security" ? 1 : 0;
  const currentHasFix = getCorrectedCode(current) ? 1 : 0;           // 1 if has a code fix
  const existingHasFix = getCorrectedCode(existing) ? 1 : 0;

  return (
    currentRank > existingRank ||  // Current is more severe → always replace
    (currentRank === existingRank && currentSecurity > existingSecurity) ||  // Same severity, current is security
    (currentRank === existingRank && currentSecurity === existingSecurity && currentHasFix > existingHasFix) || // Same severity+category, current has fix
    (
      currentRank === existingRank &&
      currentSecurity === existingSecurity &&
      currentHasFix === existingHasFix &&
      current.confidence > existing.confidence  // Same everything, higher confidence wins
    )
  );
}

/**
 * Deduplicates a mixed list of review and security issues.
 *
 * Two issues are considered duplicates if ALL of:
 *   - Same file
 *   - Same canonical topic (via canonicalTopic())
 *   - Same code snippet (normalized) OR within 2 lines of each other
 *
 * When duplicates are found, the "better" one is kept (via shouldReplaceIssue).
 * Result is sorted by file then line number for stable output.
 */
function dedupeIssues(issues: Array<ReviewIssue | SecurityIssue>): Array<ReviewIssue | SecurityIssue> {
  const chosen: Array<ReviewIssue | SecurityIssue> = [];

  for (const issue of issues) {
    const topic = canonicalTopic(issue);         // Semantic topic for this issue
    const snippet = normalizeText(issue.code_snippet); // Normalized code snippet

    // Find an existing issue that overlaps with this one
    const existingIndex = chosen.findIndex((existing) => {
      const sameFile = existing.file === issue.file;                       // Must be in same file
      const sameTopic = canonicalTopic(existing) === topic;                // Same semantic topic
      const closeLine = Math.abs(existing.line - issue.line) <= 2;        // Within 2 lines of each other
      const sameSnippet = normalizeText(existing.code_snippet) === snippet; // Same code
      return sameFile && sameTopic && (sameSnippet || closeLine);          // Duplicate if same file+topic AND (same code OR close lines)
    });

    if (existingIndex === -1) {
      // No duplicate found — add this issue to the kept list
      chosen.push(issue);
      continue;
    }

    // Duplicate found — decide whether to replace the existing one
    if (shouldReplaceIssue(issue, chosen[existingIndex])) {
      chosen[existingIndex] = issue; // Replace existing with current (it's "better")
    }
    // If current is not better, just drop it (existing stays)
  }

  // Sort by file path then line number for deterministic, readable output
  return chosen.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

/**
 * Runs deduplication across all files in the review result.
 * Deduplicates review issues and security vulnerabilities together
 * so findings from different agents that overlap are merged.
 * Modifies reviewResult in place.
 */
function dedupeReviewResult(reviewResult: ReviewResult): void {
  for (const file of reviewResult.files) {
    // Combine both lists, deduplicate, then separate back by category
    const deduped = dedupeIssues([...file.review.issues, ...file.security.vulnerabilities]);

    // Re-split: security issues back to vulnerabilities, others to review.issues
    file.review.issues = deduped.filter((issue): issue is ReviewIssue => issue.category !== "security");
    file.security.vulnerabilities = deduped.filter((issue): issue is SecurityIssue => issue.category === "security");
  }
}

// ─── Finding Converters ───────────────────────────────────────────────────────

/**
 * Extracts the "best available fix" from an issue, checking multiple field names.
 * ReviewIssue has `corrected_code` and `suggestion`.
 * SecurityIssue has `corrected_code` and `fix`.
 * Returns the first non-empty one found, or undefined if none exist.
 */
function getCorrectedCode(issue: ReviewIssue | SecurityIssue): string | undefined {
  if ("corrected_code" in issue && issue.corrected_code) return issue.corrected_code;
  if ("fix" in issue && issue.fix) return issue.fix;
  if ("suggestion" in issue && issue.suggestion) return issue.suggestion;
  return undefined;
}

/**
 * Converts a ReviewIssue or SecurityIssue into a NormalizedFinding.
 * NormalizedFinding is a flat, unified format used in reports.findings —
 * a simple deduplicated list of all findings regardless of category.
 */
function toFinding(issue: ReviewIssue | SecurityIssue): NormalizedFinding {
  return {
    id: issue.id,
    file: issue.file,
    line: issue.line,
    agent: issue.agent,
    category: issue.category,
    severity: issue.severity,
    title: issue.title,
    issue: issue.message,           // Rename message → issue for the flat format
    code_snippet: issue.code_snippet,
    corrected_code: getCorrectedCode(issue), // Best available fix
    labels: issue.labels,
    confidence: issue.confidence
  };
}

/**
 * Converts a ReviewIssue or SecurityIssue into a PRComment.
 * PRComment is the format used for posting to GitHub PRs.
 * The `body` field is left empty here — it gets formatted in github-pr.ts.
 */
function toComment(issue: ReviewIssue | SecurityIssue): PRComment {
  const correctedCode = getCorrectedCode(issue) ?? ""; // Empty string if no fix available

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
    body: ""  // Will be formatted with markdown in github-pr.ts
  };
}

// ─── Report Builders ──────────────────────────────────────────────────────────

/**
 * Builds the per-file finding count summary (reports.files).
 * Creates one FileFindingSummary per file showing how many findings
 * were found at each severity level. Used in markdown summary tables.
 */
function buildFileSummaries(reviewResult: ReviewResult): FileFindingSummary[] {
  return reviewResult.files.map((file) => {
    const findings = [...file.review.issues, ...file.security.vulnerabilities];

    return {
      file: file.file,
      total_findings: findings.length,
      // Count at each severity level using Array.filter
      critical_count: findings.filter((finding) => finding.severity === "critical").length,
      high_count: findings.filter((finding) => finding.severity === "high").length,
      medium_count: findings.filter((finding) => finding.severity === "medium").length,
      low_count: findings.filter((finding) => finding.severity === "low").length
    };
  });
}

/**
 * Builds the markdown summary string for CI output, Slack, and issue bodies.
 * Format:
 *   # PR Review Summary
 *   Decision: **approve** / **request_changes**
 *   Files reviewed: N | Total findings: N | Critical: N | High: N | ...
 *
 *   ## Files
 *   - `src/foo.ts`: 3 finding(s) [critical: 1, high: 1, medium: 0, low: 1]
 */
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

  // Only list files that actually have findings — skip clean files
  const filesWithFindings = reviewResult.reports.files.filter((entry) => entry.total_findings > 0);
  if (filesWithFindings.length === 0) {
    lines.push("No findings detected in the reviewed diff.");
    return lines.join("\n");
  }

  lines.push("## Files", "");

  // One line per file with finding counts at each severity level
  for (const file of filesWithFindings) {
    lines.push(
      `- \`${file.file}\`: ${file.total_findings} finding(s) [critical: ${file.critical_count}, high: ${file.high_count}, medium: ${file.medium_count}, low: ${file.low_count}]`
    );
  }

  return lines.join("\n");
}

/**
 * Populates the derived `reports` fields from the current files data.
 * Must be called AFTER deduplication so it reflects the final finding set.
 *
 *   reports.pr_comments   → converted PRComment objects (one per finding)
 *   reports.findings      → flat NormalizedFinding list (one per finding)
 *   reports.files         → per-file severity summary
 *   reports.markdown_summary → human-readable markdown overview
 */
function hydrateDerivedReports(reviewResult: ReviewResult): void {
  // Build flat arrays by iterating all files and combining both issue lists
  reviewResult.reports.pr_comments = reviewResult.files.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map((issue) => toComment(issue))
  );
  reviewResult.reports.findings = reviewResult.files.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map((issue) => toFinding(issue))
  );
  reviewResult.reports.files = buildFileSummaries(reviewResult);
  reviewResult.reports.markdown_summary = buildMarkdownSummary(reviewResult);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates an empty ReviewResult for a list of files.
 * Used as a starting point when:
 *   - A provider fails and we need a safe fallback
 *   - The diff has no added lines (nothing to review)
 *   - Dry-run mode (no AI call made)
 *
 * All counts are zero, decision is "approve", all arrays are empty.
 */
export function createEmptyReview(files: Array<{ file: string; language: string }>): ReviewResult {
  return {
    files: files.map((file) => ({
      file: file.file,
      language: file.language,
      changed_lines: [],
      triage: {
        needs_review: true,
        risk_level: "low",
        areas_of_concern: [],
        verdict: ""
      },
      review: {
        issues: []         // No review findings
      },
      security: {
        vulnerabilities: [] // No security findings
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
      final_decision: "approve" // Empty review = no issues = approve
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

/**
 * Finalizes a ReviewResult after agents have populated it.
 * This is the last step before returning to the caller.
 *
 * Steps:
 *   1. Deduplication — remove overlapping findings from multiple agents
 *   2. Count findings at each severity level
 *   3. Decide approve vs request_changes (any critical/high → request_changes)
 *   4. Hydrate reports: pr_comments, findings, files, markdown_summary
 *
 * @param reviewResult - The raw result from agents (may have duplicates)
 * @returns The finalized result (same object, mutated in place and returned)
 */
export function finalizeSummary(reviewResult: ReviewResult): ReviewResult {
  // Step 1: Remove duplicates that multiple agents may have reported for the same issue
  dedupeReviewResult(reviewResult);

  // Step 2: Recount all findings after deduplication
  let totalIssues = 0;
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const file of reviewResult.files) {
    // Count both review issues and security vulnerabilities
    const allIssues = [...file.review.issues, ...file.security.vulnerabilities];
    totalIssues += allIssues.length;
    for (const issue of allIssues) {
      if (issue.severity === "critical") critical += 1;
      if (issue.severity === "high") high += 1;
      if (issue.severity === "medium") medium += 1;
      if (issue.severity === "low") low += 1;
    }
  }

  // Step 3: Update summary counts
  reviewResult.summary.total_files = reviewResult.files.length;
  reviewResult.summary.total_issues = totalIssues;
  reviewResult.summary.critical_count = critical;
  reviewResult.summary.high_count = high;
  reviewResult.summary.medium_count = medium;
  reviewResult.summary.low_count = low;

  // Step 4: Set final decision — block PR if any critical or high severity finding exists
  reviewResult.summary.final_decision =
    critical > 0 || high > 0 ? "request_changes" : "approve";

  // Step 5: Populate derived reports (pr_comments, findings, files, markdown_summary)
  hydrateDerivedReports(reviewResult);

  return reviewResult;
}
