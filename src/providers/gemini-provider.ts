/**
 * Google Gemini Provider — Free tier, Gemini 2.0 Flash
 *
 * Free limits (as of 2025): 15 RPM, 1,000,000 tokens/day, 1,500 req/day
 * Get a free API key at: https://aistudio.google.com/apikey
 *
 * Env vars:
 *   GEMINI_API_KEY  — required
 *   GEMINI_MODEL    — optional, default: gemini-2.0-flash
 *
 * Uses the REST generateContent endpoint directly — no SDK required.
 * Falls back to local pattern agents on any failure.
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

export class GeminiProvider implements ReviewProvider {
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return runLocalAgentPipeline(triagedFiles);

    const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: promptPayload.system }]
          },
          contents: [
            {
              parts: [{ text: JSON.stringify(promptPayload.user) }]
            }
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        })
      });

      if (!res.ok) return runLocalAgentPipeline(triagedFiles);

      const data = await res.json() as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const parsed = safeJsonParse<ReviewResult | null>(text, null);

      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles);
    } catch {
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
