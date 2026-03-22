/**
 * ============================================================
 * FILE: src/core/prompt-builder.ts
 * PURPOSE: Builds the structured prompt payload sent to single-call AI providers
 *          (Claude via AnthropicProvider, Groq via GroqProvider, etc.).
 *
 * NOTE: Multi-agent mode (MultiAgentProvider / ai-agents.ts) builds its own
 *       per-agent prompts inline and does NOT use this builder. This builder
 *       is only used by single-call providers that send one big prompt.
 *
 * OUTPUT STRUCTURE (PromptPayload):
 *   system  → SYSTEM_PROMPT: AI persona + output JSON schema
 *   user    → REVIEW_INSTRUCTIONS + files with diff and full content
 *
 * The context_preview uses only the last 12 context lines from the diff
 * to keep the prompt size manageable. When fullFileLines is available,
 * it is included as well so the AI can review pre-existing issues.
 * ============================================================
 */

import { REVIEW_INSTRUCTIONS, SYSTEM_PROMPT } from "../config/review-rules.js";
import type { PromptPayload, TriagedFile } from "../types.js";

/**
 * Builds a PromptPayload from an array of triaged files.
 * This payload is serialized to JSON and sent as the user message
 * to single-call AI providers.
 *
 * @param files - Triaged files with diff content and triage info
 * @returns PromptPayload ready to send to an AI provider
 */
export function buildPromptPayload(files: TriagedFile[]): PromptPayload {
  // Transform each TriagedFile into the format expected by the AI prompt.
  // We slim down the data slightly (e.g., only last 12 context lines)
  // to keep prompt size manageable while preserving essential context.
  const normalizedFiles = files.map((file) => ({
    file: file.file,                           // Relative file path
    language: file.language,                   // e.g., "TypeScript", "Python"
    change_type: file.changeType,              // "logic" | "config" | "dependency"
    added_lines: file.addedLines,              // All lines added in this PR (required for review)
    context_preview: file.contextLines.slice(-12), // Last 12 context lines only (saves tokens)
    // Only include full file content if it was successfully read from disk.
    // Saves tokens when file content isn't available (e.g., new files).
    full_file_lines: file.fullFileLines?.length ? file.fullFileLines : undefined
  }));

  return {
    // System message: sets the AI's persona as a CI code reviewer
    // and specifies the exact JSON output schema it must follow.
    system: SYSTEM_PROMPT,

    // User message: review instructions + the actual changed files
    user: {
      instructions: REVIEW_INSTRUCTIONS, // Step-by-step review guidance
      files: normalizedFiles             // Files to review with diff content
    }
  };
}
