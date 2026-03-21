/**
 * GitHub Issues Reporter
 *
 * Automatically creates GitHub Issues for critical and high severity findings
 * from a PR review. Each issue gets an AI-friendly title, full markdown body
 * with code context, and appropriate labels.
 *
 * Required env vars:
 *   GITHUB_TOKEN       — personal access token or Actions GITHUB_TOKEN
 *   GITHUB_REPOSITORY  — "owner/repo" format (set automatically in GitHub Actions)
 *
 * Optional env vars:
 *   GITHUB_ISSUE_MIN_SEVERITY — minimum severity to create issues for (default: "high")
 *                               values: "critical" | "high" | "medium" | "low"
 *   GITHUB_ISSUE_LABELS       — comma-separated extra labels (default: "ai-review,automated")
 *
 * Usage:
 *   import { createGitHubIssues } from "./reporters/github-issues.js";
 *   const created = await createGitHubIssues(reviewResult, { prNumber: 42, prTitle: "Add feature" });
 */

import type { ReviewResult, Severity } from "../types.js";

export interface GitHubIssueOptions {
  /** PR number that triggered this review (used in issue body for traceability) */
  prNumber?: number;
  /** PR title (used in issue body) */
  prTitle?: string;
  /** Override repository — defaults to GITHUB_REPOSITORY env var */
  repository?: string;
}

export interface CreatedIssue {
  number: number;
  url: string;
  title: string;
  severity: Severity;
}

interface GitHubIssuePayload {
  title: string;
  body: string;
  labels: string[];
}

interface GitHubIssueResponse {
  number: number;
  html_url: string;
  title: string;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

function severityMeetsThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

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
  const prRef = params.prNumber
    ? `> Found in PR #${params.prNumber}${params.prTitle ? ` — ${params.prTitle}` : ""}\n\n`
    : "";

  const fixSection = params.correctedCode
    ? `\n## Suggested Fix\n\`\`\`\n${params.correctedCode}\n\`\`\``
    : "";

  return [
    prRef,
    `## Details`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| **File** | \`${params.file}\` |`,
    `| **Line** | ${params.line} |`,
    `| **Severity** | \`${params.severity}\` |`,
    `| **Category** | \`${params.category}\` |`,
    ``,
    `## Description`,
    ``,
    params.message,
    ``,
    `## Code`,
    ``,
    `\`\`\``,
    params.codeSnippet,
    `\`\`\``,
    fixSection,
    ``,
    `---`,
    `*Created automatically by [PR Review Orchestrator](https://github.com/anthropics/pr-review-orchestrator)*`
  ]
    .join("\n")
    .trim();
}

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
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) return null;
    return await res.json() as GitHubIssueResponse;
  } catch {
    return null;
  }
}

/**
 * Creates GitHub Issues for findings that meet the severity threshold.
 * Returns the list of successfully created issues.
 * Silently skips creation if GITHUB_TOKEN or GITHUB_REPOSITORY are not set.
 */
export async function createGitHubIssues(
  result: ReviewResult,
  options: GitHubIssueOptions = {}
): Promise<CreatedIssue[]> {
  const token = process.env.GITHUB_TOKEN;
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;

  if (!token || !repository) return [];

  const threshold = (process.env.GITHUB_ISSUE_MIN_SEVERITY ?? "high") as Severity;
  const extraLabels = (process.env.GITHUB_ISSUE_LABELS ?? "ai-review,automated")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  const created: CreatedIssue[] = [];

  for (const file of result.files) {
    // Security vulnerabilities
    for (const vuln of file.security.vulnerabilities) {
      if (!severityMeetsThreshold(vuln.severity, threshold)) continue;

      const payload: GitHubIssuePayload = {
        title: `[Security] ${vuln.title} — ${file.file}`,
        body: buildIssueBody({
          file: vuln.file,
          line: vuln.line,
          severity: vuln.severity,
          category: vuln.category,
          message: vuln.message,
          codeSnippet: vuln.code_snippet,
          correctedCode: vuln.corrected_code ?? vuln.fix,
          prNumber: options.prNumber,
          prTitle: options.prTitle
        }),
        labels: ["security", vuln.severity, ...extraLabels]
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

    // Review issues (bugs, logic, quality)
    for (const issue of file.review.issues) {
      if (!severityMeetsThreshold(issue.severity, threshold)) continue;

      const payload: GitHubIssuePayload = {
        title: `[${issue.category}] ${issue.title} — ${file.file}`,
        body: buildIssueBody({
          file: issue.file,
          line: issue.line,
          severity: issue.severity,
          category: issue.category,
          message: issue.message,
          codeSnippet: issue.code_snippet,
          correctedCode: issue.corrected_code ?? issue.suggestion,
          prNumber: options.prNumber,
          prTitle: options.prTitle
        }),
        labels: [issue.category, issue.severity, ...extraLabels]
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

  return created;
}
