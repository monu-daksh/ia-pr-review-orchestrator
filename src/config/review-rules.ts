/**
 * ============================================================
 * FILE: src/config/review-rules.ts
 * PURPOSE: Defines the AI persona and review instructions used by
 *          single-call providers (AnthropicProvider, GroqProvider, etc.).
 *
 * NOTE: Multi-agent mode (ai-agents.ts) uses its own per-agent system
 *       prompts defined in AGENT_SPECS. These strings here are only used
 *       when a single-call provider (claude/groq/gemini/ollama/openai) is active.
 *
 * SYSTEM_PROMPT:
 *   Sets the AI's persona as a CI-mode code reviewer.
 *   Instructs it to return ONLY valid JSON matching the ReviewResult schema.
 *   Any extra text (prose, markdown fences) will break JSON parsing.
 *
 * REVIEW_INSTRUCTIONS:
 *   Step-by-step guidance injected into the user message.
 *   Tells the AI to review the FULL file (not just changed lines),
 *   to only report high-confidence issues, and how to format findings.
 *
 * FUTURE UPGRADES:
 *   - Add per-language instructions (e.g., extra Python-specific rules)
 *   - Add custom rule injection (read from pr-review-orchestrator/rules.json)
 *   - Increase specificity based on triage risk level (high-risk files get stricter instructions)
 * ============================================================
 */

/**
 * System message sent to the AI.
 * Establishes the persona (CI code reviewer) and the exact JSON output format.
 * The AI must return ONLY this JSON structure — no preamble or markdown wrapping.
 *
 * The JSON schema shown here is the ReviewResult interface shape.
 * "files" is an array of ReviewFileResult objects.
 * "summary" tracks counts and the final PR decision.
 * "reports" has pr_comments and agent_runs (other report fields are added by schema.ts).
 */
export const SYSTEM_PROMPT = `You are an AI PR Review Orchestrator running in CI mode.
Return strict JSON only.
Review the full current content of any touched file when it is available — including pre-existing code.
Report issues found anywhere in the file, not only on changed lines. Use changed lines to assign accurate line numbers to findings.
If uncertain, skip.
Be concise and high-confidence.
Simulate specialized reviewers for security, bugs, logic, types, lint, and fixes.
Use this exact top-level shape:
{
  "files": [],
  "summary": {
    "total_files": 0,
    "total_issues": 0,
    "critical_count": 0,
    "high_count": 0,
    "medium_count": 0,
    "low_count": 0,
    "final_decision": "approve"
  },
  "reports": {
    "pr_comments": [],
    "agent_runs": []
  }
}`;

/**
 * Step-by-step review instructions injected into the user message.
 * These guide the AI on HOW to perform the review — what to extract,
 * what to report, and how to format its findings.
 *
 * Key rules:
 *   - Review the FULL file, not just changed lines
 *   - Use changed lines only to assign accurate line numbers
 *   - Only report issues you are confident about (no guessing)
 *   - Always include filename, line number, severity, and corrected code
 *   - Any critical or high finding must set final_decision to "request_changes"
 */
export const REVIEW_INSTRUCTIONS: string[] = [
  "Extract file paths from diff headers.",                                    // Parse the diff to know which files are being reviewed
  "Auto-detect language and change type.",                                    // Determine if file is TypeScript, Python, YAML, etc.
  "Review the full current content of touched files when available — including pre-existing code, not only the diff.", // Don't limit review to changed lines
  "Use changed lines beginning with '+' to assign accurate line numbers to findings, but report issues anywhere in the file.", // Line number accuracy
  "Use surrounding context when needed.",                                     // Use context lines to understand the change
  "Report only high-confidence issues.",                                      // No speculative or low-confidence findings
  "For each issue include filename, line number, severity label, issue text, and corrected code.", // Required fields per finding
  "If no issues exist, use empty arrays.",                                    // Return valid JSON even for clean files
  "Any high or critical issue must set final_decision to request_changes."   // Decision rule for blocking PRs
];
