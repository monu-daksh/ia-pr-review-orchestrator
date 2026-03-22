/**
 * ============================================================
 * FILE: src/reporters/github-issues.ts
 * PURPOSE: Creates GitHub Issues from critical and high severity PR review findings.
 *          Useful for tracking important security or bug findings across multiple PRs
 *          in a team's issue tracker, even after the PR is merged.
 *
 * WHEN TO USE:
 *   - Add this as a step in your GitHub Actions workflow after pr-review-orchestrator review
 *   - Configure GITHUB_ISSUE_MIN_SEVERITY=critical to only create issues for the worst findings
 *   - Useful when you want a paper trail of security findings in your issue tracker
 *
 * WHAT IT CREATES:
 *   - One GitHub Issue per finding that meets the severity threshold
 *   - Issues include: file, line, severity, category, full description, code context, fix
 *   - Issues reference the PR that triggered the finding
 *   - Issues are labeled with category, severity, and custom labels
 *
 * REQUIRED ENV VARS:
 *   GITHUB_TOKEN       — Personal access token or GitHub Actions ${{ secrets.GITHUB_TOKEN }}
 *                        Needs: issues:write permission
 *   GITHUB_REPOSITORY  — "owner/repo" format (auto-set in GitHub Actions as env var)
 *
 * OPTIONAL ENV VARS:
 *   GITHUB_ISSUE_MIN_SEVERITY — Minimum severity to create issues for (default: "high")
 *                               Values: "critical" | "high" | "medium" | "low"
 *   GITHUB_ISSUE_LABELS       — Extra comma-separated labels (default: "ai-review,automated")
 *
 * USAGE EXAMPLE:
 *   import { createGitHubIssues } from "./reporters/github-issues.js";
 *   const created = await createGitHubIssues(reviewResult, { prNumber: 42, prTitle: "Add auth" });
 *   console.log(`Created ${created.length} GitHub issues`);
 * ============================================================
 */

import type { ReviewResult, Severity } from "../types.js";

// ─── Public Interfaces ────────────────────────────────────────────────────────

/**
 * Options for GitHub issue creation.
 * All are optional — defaults come from environment variables.
 */
export interface GitHubIssueOptions {
  /** PR number that triggered this review — included in issue body for traceability */
  prNumber?: number;
  /** PR title — included in issue body context */
  prTitle?: string;
  /** Override repository — defaults to GITHUB_REPOSITORY env var */
  repository?: string;
}

/**
 * A successfully created GitHub Issue.
 * Returned by createGitHubIssues() for each issue that was created.
 */
export interface CreatedIssue {
  number: number;     // GitHub issue number (e.g., 42)
  url: string;        // HTML URL to the created issue
  title: string;      // The issue title as created on GitHub
  severity: Severity; // The severity level of the finding that triggered this issue
}

// ─── Internal Types ───────────────────────────────────────────────────────────

/**
 * Payload sent to the GitHub Issues REST API.
 */
interface GitHubIssuePayload {
  title: string;    // Issue title
  body: string;     // Markdown body
  labels: string[]; // Label strings (must exist in repo or will be created)
}

/**
 * GitHub API response when creating an issue.
 */
interface GitHubIssueResponse {
  number: number;    // Issue number assigned by GitHub
  html_url: string;  // Link to view the issue in the browser
  title: string;     // Confirmed title as stored by GitHub
}

// ─── Severity Comparison ─────────────────────────────────────────────────────

/**
 * Numeric rank for severity levels — higher is more severe.
 * Used to compare a finding's severity against the configured threshold.
 */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

/**
 * Returns true if a finding's severity meets or exceeds the threshold.
 * Example: severityMeetsThreshold("critical", "high") → true (critical > high)
 *          severityMeetsThreshold("low", "high") → false
 *
 * @param severity  - The finding's severity level
 * @param threshold - The minimum severity required to create an issue
 */
function severityMeetsThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

// ─── Issue Body Builder ───────────────────────────────────────────────────────

/**
 * Builds the full markdown body for a GitHub issue from a review finding.
 * Includes:
 *   - PR reference (e.g., "Found in PR #42 — Add auth")
 *   - Details table (file, line, severity, category)
 *   - Description of the issue
 *   - The problematic code snippet
 *   - Suggested fix code (if available)
 *   - Attribution footer
 *
 * @param params - All the data needed to build the issue body
 * @returns Formatted markdown string for the GitHub issue body
 */
function buildIssueBody(params: {
  file: string;
  line: number;
  severity: Severity;
  category: string;
  message: string;
  codeSnippet: string;
  correctedCode?: string;
  prNumber?: number;
  prTitle?: string;
}): string {
  // Link back to the PR for traceability (how to see the context of this finding)
  const prRef = params.prNumber
    ? `> Found in PR #${params.prNumber}${params.prTitle ? ` — ${params.prTitle}` : ""}\n\n`
    : "";

  // Fix section only included if a code fix was provided
  const fixSection = params.correctedCode
    ? `\n## Suggested Fix\n\`\`\`\n${params.correctedCode}\n\`\`\``
    : "";

  return [
    prRef,
    `## Details`,
    ``,
    // Metadata table for quick scanning
    `| Field | Value |`,
    `|-------|-------|`,
    `| **File** | \`${params.file}\` |`,
    `| **Line** | ${params.line} |`,
    `| **Severity** | \`${params.severity}\` |`,
    `| **Category** | \`${params.category}\` |`,
    ``,
    `## Description`,
    ``,
    params.message,        // Full explanation of the issue
    ``,
    `## Code`,
    ``,
    `\`\`\``,
    params.codeSnippet,    // The problematic code
    `\`\`\``,
    fixSection,            // Optional fix code
    ``,
    `---`,
    // Attribution footer
    `*Created automatically by [PR Review Orchestrator](https://github.com/anthropics/pr-review-orchestrator)*`
  ]
    .join("\n")
    .trim();
}

// ─── GitHub API Call ─────────────────────────────────────────────────────────

/**
 * Posts a new issue to the GitHub Issues REST API.
 * Returns the created issue data, or null on failure (silently — caller handles).
 *
 * @param token      - GitHub token with issues:write permission
 * @param repository - "owner/repo" format
 * @param payload    - Issue title, body, and labels
 * @returns The created issue response, or null if the request failed
 */
async function postIssue(
  token: string,
  repository: string,
  payload: GitHubIssuePayload
): Promise<GitHubIssueResponse | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repository}/issues`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,              // GitHub token for authentication
        "Accept": "application/vnd.github+json",         // GitHub API v3 JSON format
        "X-GitHub-Api-Version": "2022-11-28"             // Pin to a specific API version
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) return null; // API error (e.g., token lacks permission, repo not found)
    return await res.json() as GitHubIssueResponse;
  } catch {
    return null; // Network error → silently skip
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Creates GitHub Issues for all findings that meet the severity threshold.
 * Processes both security vulnerabilities and review issues (bugs, quality, etc.).
 *
 * Returns an empty array (without throwing) if:
 *   - GITHUB_TOKEN is not set (no auth)
 *   - GITHUB_REPOSITORY is not set (don't know where to create issues)
 *   - All findings are below the severity threshold
 *
 * Each finding gets its own issue. If you have 5 critical findings, 5 issues are created.
 * Issues are created sequentially (not parallel) to avoid rate limiting.
 *
 * @param result  - The complete ReviewResult from reviewDiff()
 * @param options - Optional overrides for PR number, title, and repository
 * @returns Array of successfully created issues (may be shorter than total findings if some fail)
 */
export async function createGitHubIssues(
  result: ReviewResult,
  options: GitHubIssueOptions = {}
): Promise<CreatedIssue[]> {
  const token = process.env.GITHUB_TOKEN;
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;

  // Can't create issues without auth and repository info
  if (!token || !repository) return [];

  // Which severity level is the minimum for creating an issue (default: "high")
  const threshold = (process.env.GITHUB_ISSUE_MIN_SEVERITY ?? "high") as Severity;

  // Extra labels to add to every created issue (in addition to category and severity)
  const extraLabels = (process.env.GITHUB_ISSUE_LABELS ?? "ai-review,automated")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean); // Remove empty strings

  const created: CreatedIssue[] = [];

  for (const file of result.files) {
    // ── Create issues for security vulnerabilities ──────────────────────────
    for (const vuln of file.security.vulnerabilities) {
      if (!severityMeetsThreshold(vuln.severity, threshold)) continue; // Skip if below threshold

      const payload: GitHubIssuePayload = {
        title: `[Security] ${vuln.title} — ${file.file}`, // Clearly prefix with [Security]
        body: buildIssueBody({
          file: vuln.file,
          line: vuln.line,
          severity: vuln.severity,
          category: vuln.category,
          message: vuln.message,
          codeSnippet: vuln.code_snippet,
          correctedCode: vuln.corrected_code ?? vuln.fix, // Prefer corrected_code over fix
          prNumber: options.prNumber,
          prTitle: options.prTitle
        }),
        labels: ["security", vuln.severity, ...extraLabels] // Always tag with "security" + severity
      };

      const created_issue = await postIssue(token, repository, payload);
      if (created_issue) {
        created.push({
          number: created_issue.number,
          url: created_issue.html_url,
          title: created_issue.title,
          severity: vuln.severity
        });
      }
    }

    // ── Create issues for review findings (bugs, quality, performance) ─────
    for (const issue of file.review.issues) {
      if (!severityMeetsThreshold(issue.severity, threshold)) continue;

      const payload: GitHubIssuePayload = {
        title: `[${issue.category}] ${issue.title} — ${file.file}`, // e.g., "[bug] Missing await — src/api.ts"
        body: buildIssueBody({
          file: issue.file,
          line: issue.line,
          severity: issue.severity,
          category: issue.category,
          message: issue.message,
          codeSnippet: issue.code_snippet,
          correctedCode: issue.corrected_code ?? issue.suggestion, // Prefer code fix over text suggestion
          prNumber: options.prNumber,
          prTitle: options.prTitle
        }),
        labels: [issue.category, issue.severity, ...extraLabels] // e.g., ["bug", "high", "ai-review"]
      };

      const created_issue = await postIssue(token, repository, payload);
      if (created_issue) {
        created.push({
          number: created_issue.number,
          url: created_issue.html_url,
          title: created_issue.title,
          severity: issue.severity
        });
      }
    }
  }

  return created; // Return all successfully created issues
}
