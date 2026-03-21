/**
 * Ollama Provider — Local models, completely free, offline-capable
 *
 * Requires Ollama running locally: https://ollama.com
 * Recommended models for code review:
 *   ollama pull codellama       — best for code
 *   ollama pull llama3.2        — good general purpose
 *   ollama pull deepseek-coder  — specialized for code
 *
 * Env vars:
 *   OLLAMA_HOST   — optional, default: http://localhost:11434
 *   OLLAMA_MODEL  — optional, default: llama3.2
 *
 * Falls back to local pattern agents if Ollama is unreachable.
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

interface OllamaChatResponse {
  message?: { content?: string };
}

export class OllamaProvider implements ReviewProvider {
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    const model = process.env.OLLAMA_MODEL ?? "llama3.2";

    try {
      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: "system", content: promptPayload.system },
            { role: "user", content: JSON.stringify(promptPayload.user) }
          ],
          options: { num_predict: 4096, temperature: 0.1 }
        })
      });

      if (!res.ok) return runLocalAgentPipeline(triagedFiles);

      const data = await res.json() as OllamaChatResponse;
      const text = data.message?.content ?? "";
      const parsed = safeJsonParse<ReviewResult | null>(text, null);

      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles);
    } catch {
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
