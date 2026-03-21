/**
 * Groq Provider — Free tier, Llama 3.3 70B
 *
 * Free limits (as of 2025): 30 req/min, 14,400 req/day, 6,000 tokens/sec
 * Get a free API key at: https://console.groq.com
 *
 * Env vars:
 *   GROQ_API_KEY   — required
 *   GROQ_MODEL     — optional, default: llama-3.3-70b-versatile
 *
 * Uses the OpenAI-compatible /v1/chat/completions endpoint.
 * Falls back to local pattern agents on any failure.
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

interface GroqMessage {
  role: "system" | "user";
  content: string;
}

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class GroqProvider implements ReviewProvider {
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return runLocalAgentPipeline(triagedFiles);

    const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

    const messages: GroqMessage[] = [
      { role: "system", content: promptPayload.system },
      { role: "user", content: JSON.stringify(promptPayload.user) }
    ];

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, max_tokens: 4096, temperature: 0.1 })
      });

      if (!res.ok) return runLocalAgentPipeline(triagedFiles);

      const data = await res.json() as GroqResponse;
      const text = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeJsonParse<ReviewResult | null>(text, null);

      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles);
    } catch {
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
