import type { ReviewResult } from "../types.js";

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
      agent_runs: []
    }
  };
}

export function finalizeSummary(reviewResult: ReviewResult): ReviewResult {
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

  return reviewResult;
}

