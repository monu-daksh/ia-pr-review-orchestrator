/**
 * ============================================================
 * FILE: src/providers/openai-provider.ts
 * PURPOSE: Single-call OpenAI provider for PR reviews.
 *          Uses the official openai npm SDK (dynamically imported).
 *
 * WHEN TO USE:
 *   Set OPENAI_API_KEY to use this provider. When only OPENAI_API_KEY is
 *   configured, the auto-detector selects "openai" mode (single-call).
 *   Unlike Claude/Groq/Gemini/Ollama, OpenAI does NOT get multi-agent mode —
 *   it always uses a single combined prompt.
 *
 *   To force: set PR_REVIEW_PROVIDER=openai
 *
 * SDK: openai (optional dependency — loaded dynamically)
 *   Install: npm install openai
 *   If not installed, automatically falls back to local pattern agents.
 *
 * FALLBACK:
 *   - If openai SDK not installed → local pattern agents
 *   - If API call fails → local pattern agents
 *   - If response isn't valid ReviewResult JSON → local pattern agents
 *
 * ENV VARS:
 *   OPENAI_API_KEY  — required
 *   OPENAI_MODEL    — optional (default: gpt-5.4-mini)
 * ============================================================
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewResult, TriagedFile, ReviewProvider } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

export class OpenAIProvider implements ReviewProvider {
  /**
   * Reviews changed files using a single OpenAI API call.
   * Dynamically imports the openai SDK — if not installed, falls back to local agents.
   *
   * @param promptPayload - System prompt + review instructions + file content
   * @param triagedFiles  - Used for local agent fallback if OpenAI fails
   * @returns ReviewResult from OpenAI, or local pattern agent fallback
   */
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    // Dynamic import — keeps openai SDK optional.
    // If the user hasn't run `npm install openai`, we fall back gracefully.
    let OpenAI: typeof import("openai").default;
    try {
      ({ default: OpenAI } = await import("openai"));
    } catch {
      // openai SDK not installed → fall back to local pattern agents
      return runLocalAgentPipeline(triagedFiles);
    }

    // Initialize the OpenAI client with the API key from environment
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    try {
      // Use the Responses API (newer than Chat Completions) for structured output
      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-5.4-mini", // Default to fast, cheap model
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: promptPayload.system }]  // AI persona + output schema
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(promptPayload.user) }] // Review instructions + files
          }
        ]
      });

      const text = response.output_text || ""; // Extract response text

      // Parse the response as ReviewResult JSON
      const parsed = safeJsonParse<ReviewResult | null>(text, null);

      // Valid ReviewResult must have a files array
      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles); // Bad response → local fallback
    } catch {
      // API error or network failure → local pattern agent fallback
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
