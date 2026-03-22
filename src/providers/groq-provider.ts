/**
 * ============================================================
 * FILE: src/providers/groq-provider.ts
 * PURPOSE: Single-call Groq provider for PR reviews.
 *          Sends ONE combined prompt to Groq and parses the JSON response.
 *
 * WHEN TO USE THIS vs. multi-agent:
 *   This provider sends a single large prompt to Groq. It's simpler but
 *   less thorough than the multi-agent mode (which sends 9 focused prompts).
 *   Use this if you set PR_REVIEW_PROVIDER=groq explicitly.
 *   If you just set GROQ_API_KEY, the auto-detector will use "multi-agent"
 *   mode which is better — it uses Groq for each specialized agent.
 *
 * FREE TIER LIMITS (as of 2025):
 *   30 requests/minute, 14,400 requests/day, 6,000 tokens/second
 *   Get a free API key at: https://console.groq.com
 *
 * FALLBACK:
 *   If the API call fails OR the response can't be parsed as valid ReviewResult JSON,
 *   falls back to local pattern agents (runLocalAgentPipeline).
 *   The review ALWAYS returns a result — never throws.
 *
 * ENV VARS:
 *   GROQ_API_KEY  — required (provider returns local fallback if missing)
 *   GROQ_MODEL    — optional (default: llama-3.3-70b-versatile)
 * ============================================================
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

/**
 * Groq API request message format.
 * Groq uses the OpenAI-compatible chat completions format.
 */
interface GroqMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Groq API response shape (OpenAI-compatible).
 * The AI response text is at choices[0].message.content.
 */
interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class GroqProvider implements ReviewProvider {
  /**
   * Reviews changed files using a single Groq API call.
   * Sends the full prompt payload and expects a ReviewResult JSON response.
   *
   * @param promptPayload - System prompt + review instructions + file content
   * @param triagedFiles  - Used for local agent fallback if Groq fails
   * @returns ReviewResult from Groq, or local pattern agent fallback
   */
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    const apiKey = process.env.GROQ_API_KEY;
    // No API key → immediately use local pattern agents (don't try to call API)
    if (!apiKey) return runLocalAgentPipeline(triagedFiles);

    const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile"; // Best free Groq model

    // Build the message array: system prompt + user content (serialized to JSON)
    const messages: GroqMessage[] = [
      { role: "system", content: promptPayload.system },              // AI persona + output schema
      { role: "user", content: JSON.stringify(promptPayload.user) }   // Review instructions + files
    ];

    try {
      // Call the Groq API using their OpenAI-compatible endpoint
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}` // Groq uses Bearer token authentication
        },
        // temperature: 0.1 for more deterministic, JSON-friendly responses
        body: JSON.stringify({ model, messages, max_tokens: 4096, temperature: 0.1 })
      });

      // Non-200 response → API error, fall back to local agents
      if (!res.ok) return runLocalAgentPipeline(triagedFiles);

      const data = await res.json() as GroqResponse;
      const text = data.choices?.[0]?.message?.content ?? ""; // Extract response text

      // Attempt to parse the response as a ReviewResult JSON object
      const parsed = safeJsonParse<ReviewResult | null>(text, null);

      // Valid ReviewResult must have a files array — if parsing failed or
      // the structure is wrong, fall back to local pattern agents
      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles);
    } catch {
      // Network error, JSON error, or any unexpected failure → local agent fallback
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
