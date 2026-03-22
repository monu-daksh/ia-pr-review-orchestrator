/**
 * ============================================================
 * FILE: src/providers/gemini-provider.ts
 * PURPOSE: Single-call Google Gemini provider for PR reviews.
 *          Sends ONE combined prompt to Gemini and parses the JSON response.
 *
 * WHEN TO USE THIS vs. multi-agent:
 *   This provider sends a single large prompt to Gemini. It's simpler but
 *   less thorough than the multi-agent mode (which sends 9 focused prompts).
 *   Use this if you set PR_REVIEW_PROVIDER=gemini explicitly.
 *   If you just set GEMINI_API_KEY, the auto-detector uses "multi-agent"
 *   mode which is better — it uses Gemini for each specialized agent.
 *
 * FREE TIER LIMITS (as of 2025):
 *   15 requests/minute, 1,000,000 tokens/day, 1,500 requests/day
 *   Get a free API key at: https://aistudio.google.com/apikey
 *
 * FALLBACK:
 *   If the API call fails OR the response can't be parsed as valid ReviewResult JSON,
 *   falls back to local pattern agents (runLocalAgentPipeline).
 *   The review ALWAYS returns a result — never throws.
 *
 * ENV VARS:
 *   GEMINI_API_KEY  — required (provider returns local fallback if missing)
 *   GEMINI_MODEL    — optional (default: gemini-2.0-flash)
 *
 * RESPONSE FORMAT:
 *   Gemini is asked for responseMimeType: "application/json" to improve
 *   response quality and reduce markdown wrapping around the JSON output.
 * ============================================================
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

/**
 * Gemini API response shape.
 * The text response is nested: candidates[0].content.parts[0].text
 */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

export class GeminiProvider implements ReviewProvider {
  /**
   * Reviews changed files using a single Gemini API call.
   * Sends the full prompt payload and expects a ReviewResult JSON response.
   *
   * @param promptPayload - System prompt + review instructions + file content
   * @param triagedFiles  - Used for local agent fallback if Gemini fails
   * @returns ReviewResult from Gemini, or local pattern agent fallback
   */
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    // No API key → immediately use local pattern agents
    if (!apiKey) return runLocalAgentPipeline(triagedFiles);

    const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash"; // Fast, generous free limits

    // Build the API URL — Gemini uses the API key as a query parameter
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Gemini has a separate system_instruction field (not in the messages array)
          system_instruction: {
            parts: [{ text: promptPayload.system }] // AI persona + output schema
          },
          contents: [
            {
              parts: [{ text: JSON.stringify(promptPayload.user) }] // Review instructions + files
            }
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.1,            // Low temperature for deterministic JSON responses
            responseMimeType: "application/json" // Ask Gemini to return JSON directly (reduces wrapping)
          }
        })
      });

      // Non-200 response → API error (rate limit, auth failure), fall back to local agents
      if (!res.ok) return runLocalAgentPipeline(triagedFiles);

      const data = await res.json() as GeminiResponse;
      // Gemini nests the text: candidates[0].content.parts[0].text
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      // Try to parse the response as a ReviewResult JSON
      const parsed = safeJsonParse<ReviewResult | null>(text, null);

      // Valid ReviewResult must have a files array
      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles); // Bad response → local fallback
    } catch {
      // Network error or any unexpected failure → local agent fallback
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
