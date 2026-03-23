/**
 * ============================================================
 * FILE: src/types.ts
 * PURPOSE: Central TypeScript type definitions for the entire project.
 *          Every interface, type alias, and enum used across all modules
 *          is declared here — so changing a type in one place updates
 *          the whole system without hunting through files.
 * ============================================================
 */

// ─── Primitive Union Types ────────────────────────────────────────────────────

/** How risky a file is, based on the areas of code it touches. */
export type RiskLevel = "low" | "medium" | "high";

/**
 * How serious a finding is. Used to decide whether to approve or block a PR.
 *   critical + high  → final_decision becomes "request_changes"
 *   medium + low     → PR is still approved, findings are advisory
 */
export type Severity = "critical" | "high" | "medium" | "low";

/**
 * Which bucket a finding belongs to. Used for routing, labels, and filtering.
 *   security   → XSS, SQL injection, leaked secrets, etc.
 *   bug        → null deref, unhandled async, infinite loops, etc.
 *   performance→ expensive renders, missing memo, blocking loops
 *   quality    → style, types, best practices, lint violations
 */
export type IssueCategory = "bug" | "security" | "performance" | "quality";

/**
 * Name of the specialized agent that produced a finding.
 * Each agent has its own focused system prompt and confidence score.
 *   security        → XSS, injection, credential leaks
 *   bug             → runtime bugs, async misuse, null deref
 *   logic           → wrong conditions, loose equality, state sync
 *   types           → any usage, missing types, unsafe assertions
 *   eslint          → console statements, unused vars, var keyword
 *   performance     → expensive renders, missing useMemo/useCallback
 *   best-practices  → hardcoded values, missing error handling
 *   quality         → component structure, side effects in render
 *   fix             → auto-generated patches (not a review agent)
 */
export type AgentName = "security" | "bug" | "logic" | "types" | "eslint" | "performance" | "best-practices" | "quality" | "fix";

/**
 * Name of the AI provider to use.
 *   multi-agent → 9 specialized agents in parallel (recommended)
 *   claude      → single Claude call (Anthropic SDK, paid)
 *   groq        → single Groq call (OpenAI-compat REST, free tier)
 *   gemini      → single Gemini call (Google REST, free tier)
 *   ollama      → single local model call (offline, completely free)
 *   openai      → single OpenAI call (OpenAI SDK, paid)
 *   local       → pattern-based agents only — no AI, always works
 */
export type ProviderName = "multi-agent" | "claude" | "groq" | "gemini" | "ollama" | "openai" | "local";

/**
 * Options the user selects when running `pr-review-orchestrator init`.
 * Maps to the same AI providers but without the internal "multi-agent" alias.
 */
export type InstallProviderChoice = "groq" | "gemini" | "ollama" | "anthropic" | "openai" | "local";

// ─── Diff Line Representations ───────────────────────────────────────────────

/**
 * A single line that was ADDED in the diff (lines starting with "+").
 * `line` is the new line number in the post-change file.
 */
export interface AddedLine {
  line: number;     // The line number in the new file version
  content: string;  // The actual code on that line (without the leading "+")
}

/**
 * A single line of context (unchanged lines surrounding the diff hunk).
 * Used to give AI agents more surrounding code to reason about.
 * Also used for full-file content loaded from disk.
 */
export interface ContextLine {
  line: number;     // Line number in the file
  content: string;  // The actual code on that line
}

// ─── Language Detection ───────────────────────────────────────────────────────

/**
 * Metadata for a programming language or file type.
 * Defined in src/config/language-profiles.ts.
 *
 * `areas` are the default review concerns before triage analysis —
 * e.g., TypeScript files always review "api" and "async" by default.
 *
 * `type` classifies the file for routing:
 *   logic      → executable code (TypeScript, Python, Java, etc.)
 *   config     → config files (JSON, YAML, .env)
 *   dependency → package manifests (package.json, pom.xml, .gradle)
 */
export interface LanguageProfile {
  language: string;    // Display name, e.g., "TypeScript" or "Python"
  extensions: string[];// File extensions to match, e.g., [".ts", ".tsx"]
  areas: string[];     // Default concern areas for this language
  type: string;        // Classification: "logic" | "config" | "dependency"
}

// ─── Diff Parsing ─────────────────────────────────────────────────────────────

/**
 * The result of parsing a single file from a unified diff.
 * Produced by src/core/diff-parser.ts.
 *
 * `addedLines`    → lines prefixed with "+" in the diff
 * `contextLines`  → unchanged lines around the diff hunk (limited preview)
 * `fullFileLines` → entire current file read from disk (if available)
 *                   AI agents use fullFileLines to review pre-existing issues too
 */
export interface ParsedDiffFile {
  file: string;               // Relative file path, e.g., "src/api/user.ts"
  language: string;           // Detected language name
  changeType: string;         // "logic" | "config" | "dependency"
  defaultAreas: string[];     // Default concern areas from the language profile
  addedLines: AddedLine[];    // Only the newly added lines in this diff
  contextLines: ContextLine[];// A few lines of surrounding context from the diff
  fullFileLines?: ContextLine[];// Full file content read from disk (enriched in review-engine.ts)
}

// ─── Triage ───────────────────────────────────────────────────────────────────

/**
 * Risk assessment for a single file, produced by src/core/triage.ts.
 * The triage runs before the AI review and helps agents prioritize effort.
 *
 * `needs_review`     → false only if there were zero added lines
 * `risk_level`       → high (auth/db/crypto/env), medium (3+ areas), low (default)
 * `areas_of_concern` → union of defaultAreas + dynamically detected areas
 * `verdict`          → human-readable one-liner, shown in logs and reports
 */
export interface TriageResult {
  needs_review: boolean;
  risk_level: RiskLevel;
  areas_of_concern: string[];
  verdict: string;
}

/**
 * A parsed diff file with its triage result attached.
 * This is the main type passed into agents and providers.
 */
export interface TriagedFile extends ParsedDiffFile {
  triage: TriageResult;
}

// ─── Review Findings ──────────────────────────────────────────────────────────

/**
 * A non-security finding: bug, performance, quality, logic, lint, or type issue.
 * Produced by both AI agents (ai-agents.ts) and pattern agents (local-agents.ts).
 *
 * `id`             → unique ID: "R-{agent}-{file}-{line}"
 * `suggestion`     → plain-text advice (advisory, not a code fix)
 * `corrected_code` → actual replacement code (shown as "fix" in PR comments)
 * `confidence`     → 0.0–1.0 score; used during deduplication to keep the best finding
 */
export interface ReviewIssue {
  id: string;
  category: IssueCategory;    // "bug" | "performance" | "quality"
  severity: Severity;         // How serious this is
  agent: AgentName;           // Which agent produced this
  file: string;               // File where the issue was found
  line: number;               // Line number in the file
  code_snippet: string;       // The problematic code fragment
  title: string;              // Short headline, e.g., "Untracked async fetch call"
  message: string;            // Full explanation of why this is a problem
  suggestion: string;         // Advisory text (when no code fix is available)
  corrected_code?: string;    // Replacement code snippet (preferred over suggestion)
  labels: string[];           // Tags for filtering: ["bug", "medium", "async"]
  confidence: number;         // Agent's confidence: 0.71 (patterns) to 0.99 (exact match)
}

/**
 * A security-specific finding. Same structure as ReviewIssue but with:
 *   - category always "security"
 *   - agent always "security"
 *   - `fix` instead of `suggestion` (always actionable)
 *
 * `id` format: "S-{file}-{line}-{type}" (e.g., "S-src/app.tsx-42-xss")
 */
export interface SecurityIssue {
  id: string;
  category: "security";         // Always "security"
  severity: Severity;
  agent: "security";            // Always the security agent
  file: string;
  line: number;
  code_snippet: string;
  title: string;
  message: string;
  fix: string;                  // Required actionable fix (unlike suggestion which is optional)
  corrected_code?: string;      // Replacement code (alias for fix, used in rendering)
  labels: string[];             // e.g., ["security", "critical", "sql-injection"]
  confidence: number;
}

// ─── Patches & Fixes ─────────────────────────────────────────────────────────

/**
 * A single code patch: the original problematic line and its replacement.
 * Patches are collected across all agents and used to build:
 *   - ReviewFileResult.fix.fixed_code (full patched version of the file)
 *   - ReviewFileResult.fix.changes_summary (human-readable change descriptions)
 */
export interface Patch {
  file: string;      // Which file to patch
  line: number;      // Which line to replace
  original: string;  // The original code (for context/diff display)
  fixed: string;     // The replacement code
}

// ─── PR Comments ──────────────────────────────────────────────────────────────

/**
 * A formatted PR comment ready to be posted to GitHub.
 * Produced by schema.ts (toComment) and further formatted by github-pr.ts.
 *
 * `body` is the markdown body of the comment as it will appear on GitHub.
 * `corrected_code` is the suggested fix shown in the comment.
 */
export interface PRComment {
  id: string;
  file: string;
  line: number;
  agent: AgentName;
  severity: Severity;
  category: IssueCategory;
  title: string;
  issue: string;           // The issue explanation text (same as message)
  code_snippet: string;
  corrected_code: string;  // Rendered fix code (may be empty string if no fix available)
  labels: string[];
  body: string;            // Final markdown text for the GitHub comment body
}

// ─── Agent Run Tracking ───────────────────────────────────────────────────────

/**
 * Summary of one agent's run, included in the final report.
 * Lets you see at a glance how many findings each agent found.
 *
 * For "fix" agent: `findings` is the number of auto-generated patches.
 * For all other agents: `findings` is the number of issues detected.
 */
export interface AgentRunSummary {
  agent: AgentName;
  findings: number;
  status: "completed";   // Always "completed" — failed runs fall back to local
}

// ─── Normalized Findings (for flat export) ────────────────────────────────────

/**
 * A deduplicated, normalized view of a finding for the `reports.findings` array.
 * Used when consumers want a flat list of all findings without the file structure.
 * Produced by schema.ts (toFinding) after deduplication.
 *
 * `issue` is the explanation text (same as ReviewIssue.message / PRComment.issue).
 */
export interface NormalizedFinding {
  id: string;
  file: string;
  line: number;
  agent: AgentName;
  category: IssueCategory;
  severity: Severity;
  title: string;
  issue: string;            // The explanation text
  code_snippet: string;
  corrected_code?: string;
  labels: string[];
  confidence: number;
}

// ─── Per-File Finding Counts ──────────────────────────────────────────────────

/**
 * A per-file summary of how many findings were found at each severity level.
 * Populated in schema.ts (buildFileSummaries) and included in reports.files.
 * Used by the markdown summary and GitHub PR report tables.
 */
export interface FileFindingSummary {
  file: string;
  total_findings: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
}

// ─── Per-File Review Result ───────────────────────────────────────────────────

/**
 * The complete review result for a single file.
 * Produced by agents (ai-agents.ts / local-agents.ts) and collected
 * by review-engine.ts into a ReviewResult.
 *
 * `changed_lines`  → line numbers that were added in this PR (used for inline comment placement)
 * `review.issues`  → non-security findings
 * `security.vulnerabilities` → security findings
 * `fix`            → auto-generated patches collected from all agents
 */
export interface ReviewFileResult {
  file: string;
  language: string;
  changed_lines?: number[];      // PR diff line numbers (used by GitHub inline comments)
  triage: TriageResult;          // Risk level and areas of concern for this file
  review: {
    issues: ReviewIssue[];       // All non-security findings for this file
  };
  security: {
    vulnerabilities: SecurityIssue[]; // All security findings for this file
  };
  fix: {
    required: boolean;           // true if any agent produced patches
    fixed_code: string;          // Full patched file content (only diff lines shown)
    patches: Patch[];            // Individual line patches
    changes_summary: string[];   // Human-readable descriptions of each patch
  };
}

// ─── Top-Level Review Result ─────────────────────────────────────────────────

/**
 * The complete PR review result returned by reviewDiff().
 * This is the main output object of the entire system.
 *
 * `files`   → per-file results with all findings and patches
 * `summary` → aggregate counts and the final PR decision
 * `reports` → pre-formatted outputs for different consumers:
 *               pr_comments    → GitHub PR inline comments
 *               agent_runs     → per-agent finding counts
 *               findings       → flat deduplicated list of all findings
 *               files          → per-file finding count table
 *               markdown_summary → human-readable markdown for CI logs
 */
export interface ReviewResult {
  files: ReviewFileResult[];
  summary: {
    total_files: number;
    total_issues: number;
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
    final_decision: "approve" | "request_changes"; // "request_changes" if any critical or high finding exists
  };
  reports: {
    pr_comments: PRComment[];             // Ready-to-post GitHub PR comments
    agent_runs: AgentRunSummary[];        // Per-agent run results
    findings: NormalizedFinding[];        // Flat, deduplicated list of all findings
    files: FileFindingSummary[];          // Per-file severity breakdown
    markdown_summary: string;             // Markdown summary for CI output or Slack
  };
}

// ─── Prompt Payload ───────────────────────────────────────────────────────────

/**
 * The structured prompt sent to single-call AI providers (Claude, Groq, Gemini, Ollama).
 * Built by src/core/prompt-builder.ts from TriagedFile[].
 *
 * `system`              → SYSTEM_PROMPT from review-rules.ts (persona + JSON schema)
 * `user.instructions`   → REVIEW_INSTRUCTIONS from review-rules.ts (review guidance)
 * `user.files`          → the actual changed files with diff content
 */
export interface PromptPayload {
  system: string;   // System message sent to the AI (persona + output format)
  user: {
    instructions: string[];   // Step-by-step review instructions for the AI
    files: Array<{
      file: string;
      language: string;
      change_type: string;
      added_lines: AddedLine[];            // Lines added in the PR diff
      context_preview: ContextLine[];      // Last 12 lines of context from the diff
      full_file_lines?: ContextLine[];     // Full file content (when available)
    }>;
  };
}

// ─── Provider Interface ───────────────────────────────────────────────────────

/**
 * Interface that every AI/local provider must implement.
 * Providers receive the prompt payload and triaged files, and return a ReviewResult.
 *
 * Implementations: AnthropicProvider, GroqProvider, GeminiProvider,
 *                  OllamaProvider, OpenAIProvider, MultiAgentProvider, LocalProvider
 *
 * If a provider fails at any point, it should fall back to runLocalAgentPipeline()
 * rather than throwing — so the system always returns a valid result.
 */
export interface ReviewProvider {
  review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult>;
}

// ─── Judge Agent ─────────────────────────────────────────────────────────────

/**
 * Judge's verdict on a single finding from any agent.
 * `keep`         → true = validated real issue, false = false positive / out of scope
 * `duplicate_of` → if set, this finding is a duplicate of the given finding ID
 * `reason`       → one-line explanation for the decision
 */
export interface JudgeFindingDecision {
  id: string;
  keep: boolean;
  reason: string;
  duplicate_of?: string;
}

/**
 * A gap the judge detected — an issue that existed in the code
 * but no agent caught. The judge names the agent responsible for it.
 */
export interface JudgeGap {
  agent: Exclude<AgentName, "fix">;  // Which agent SHOULD have found this
  missed: string;                    // Description of what was missed
  line?: number;                     // Approximate line number
  severity: Severity;                // How serious the missed issue is
}

/**
 * Judge's performance score for a single agent.
 * `score`       → 0.0 (missed everything) to 1.0 (perfect coverage)
 * `needs_retry` → true if score < 0.5 or agent missed critical/high issues
 * `gaps`        → human-readable list of specific things the agent missed
 */
export interface JudgeAgentScore {
  agent: Exclude<AgentName, "fix">;
  score: number;
  needs_retry: boolean;
  gaps: string[];
}

/**
 * Complete verdict from the Judge Agent for a single file.
 * Produced by judge-agent.ts after reviewing all 8 agent outputs.
 *
 * `decisions`    → keep/dismiss decision on every individual finding
 * `gaps`         → issues that existed but no agent caught
 * `agent_scores` → quality score (0–1) per agent
 * `retry_agents` → agents that need to re-run (score < 0.5 or missed critical/high)
 * `summary`      → one-line judge assessment for logging
 */
export interface JudgeVerdict {
  decisions:    JudgeFindingDecision[];
  gaps:         JudgeGap[];
  agent_scores: JudgeAgentScore[];
  retry_agents: Exclude<AgentName, "fix">[];
  summary:      string;
}

// ─── CLI Options ──────────────────────────────────────────────────────────────

/**
 * Options passed to reviewDiff() from the CLI or library consumers.
 *
 * `dryRun`   → returns parsed files and prompt payload only (no AI call)
 * `provider` → override the auto-detected provider
 * `format`   → "json" (default) or "github-pr" (formatted GitHub comments)
 */
export interface ReviewOptions {
  dryRun?: boolean;
  provider?: string;
  format?: "json" | "github-pr";
}

/**
 * Return type when dryRun is true.
 * Useful for debugging: shows exactly what the diff parsed to and
 * what prompt would have been sent to the AI.
 */
export interface DryRunResult {
  parsed_files: TriagedFile[];     // Parsed and triaged files from the diff
  prompt_payload: PromptPayload;   // The prompt that would have been sent to the AI
}
