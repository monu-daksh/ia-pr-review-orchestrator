/**
 * ============================================================
 * FILE: src/index.ts
 * PURPOSE: Public library API — what gets exported when someone
 *          does `import { reviewDiff } from "pr-review-orchestrator"`.
 *
 * EXPORTS:
 *   reviewDiff()               — Main function: review a diff string, returns ReviewResult
 *   initProject()              — Setup wizard: generates config files and CI workflows
 *   buildGithubPRReviewReport()— Format: converts ReviewResult to GitHub PR comment format
 *   createGitHubIssues()       — Integration: posts findings as GitHub Issues
 *   detectAvailableAI()        — Diagnostics: which AI provider is configured
 *
 * USAGE EXAMPLES:
 *   // Review a diff in Node.js code:
 *   import { reviewDiff } from "pr-review-orchestrator";
 *   const result = await reviewDiff(diffText);
 *   console.log(result.summary.final_decision); // "approve" or "request_changes"
 *
 *   // Get GitHub PR comment format:
 *   import { reviewDiff, buildGithubPRReviewReport } from "pr-review-orchestrator";
 *   const result = await reviewDiff(diffText);
 *   const report = buildGithubPRReviewReport(result);
 *   // post report.comments to GitHub API
 *
 *   // Check which AI is available:
 *   import { detectAvailableAI } from "pr-review-orchestrator";
 *   const ai = detectAvailableAI(); // "claude" | "groq" | "gemini" | "ollama" | "none"
 * ============================================================
 */

/** Main review function — takes a unified diff string, returns a full ReviewResult */
export { reviewDiff } from "./core/review-engine.js";

/** Setup wizard — generates pr-review-orchestrator/init.json, GitHub Actions workflow, etc. */
export { initProject } from "./setup/init-project.js";

/** Format converter — turns ReviewResult into GitHub PR review comment format */
export { buildGithubPRReviewReport } from "./reporters/github-pr.js";

/** HTML reporter — turns ReviewResult into a self-contained, CSS-styled HTML page */
export { buildHTMLReport } from "./reporters/html-reporter.js";

/** GitHub integration — posts critical/high findings as GitHub Issues */
export { createGitHubIssues } from "./reporters/github-issues.js";

/** Diagnostics — returns which AI provider is currently configured */
export { detectAvailableAI } from "./utils/ai-call.js";
