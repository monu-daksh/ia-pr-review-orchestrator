/**
 * ============================================================
 * FILE: src/providers/ollama-provider.ts
 * PURPOSE: Single-call local Ollama provider for PR reviews.
 *          Completely free, offline-capable, no API key needed.
 *
 * WHAT IS OLLAMA?
 *   Ollama lets you run open-source LLMs locally on your machine.
 *   Install from: https://ollama.com
 *   After install, pull a model:
 *     ollama pull codellama       ← best for code analysis
 *     ollama pull llama3.2        ← good general purpose model
 *     ollama pull deepseek-coder  ← specialized for code review
 *
 * WHEN TO USE THIS vs. multi-agent:
 *   This provider sends a single large prompt to Ollama. Less thorough
 *   than multi-agent mode but simpler.
 *   If you set OLLAMA_HOST, the auto-detector uses "multi-agent" (better).
 *   Use PR_REVIEW_PROVIDER=ollama to force single-call mode.
 *
 * FALLBACK:
 *   If Ollama is not running or the model isn't available, falls back
 *   to local pattern agents. The review ALWAYS returns a result — never throws.
 *
 * ENV VARS:
 *   OLLAMA_HOST   — optional (default: http://localhost:11434)
 *   OLLAMA_MODEL  — optional (default: llama3.2)
 *
 * TIPS FOR BETTER RESULTS:
 *   Larger models give better reviews but use more RAM.
 *   codellama is optimized for code and often outperforms llama3.2 on security reviews.
 *   deepseek-coder is another strong option for code-focused review.
 * ============================================================
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

/**
 * Ollama chat API response shape.
 * Much simpler than cloud providers — just message.content.
 */
interface OllamaChatResponse {
  message?: { content?: string }; // The model's response text
}

export class OllamaProvider implements ReviewProvider {
  /**
   * Reviews changed files using a single Ollama API call.
   * Connects to the local Ollama instance and sends the full prompt payload.
   *
   * @param promptPayload - System prompt + review instructions + file content
   * @param triagedFiles  - Used for local agent fallback if Ollama is unreachable
   * @returns ReviewResult from Ollama, or local pattern agent fallback
   */
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    const host = process.env.OLLAMA_HOST ?? "http://localhost:11434"; // Default local endpoint
    const model = process.env.OLLAMA_MODEL ?? "llama3.2";             // Default model

    try {
      // Call the Ollama chat API
      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false, // Disable streaming — get complete response at once
          messages: [
            { role: "system", content: promptPayload.system },              // AI persona + output schema
            { role: "user", content: JSON.stringify(promptPayload.user) }   // Review instructions + files
          ],
          options: {
            num_predict: 4096, // Maximum tokens to generate
            temperature: 0.1   // Low temperature for deterministic, JSON-friendly responses
          }
        })
      });

      // Non-200 response → Ollama running but model error, fall back to local agents
      if (!res.ok) return runLocalAgentPipeline(triagedFiles);

      const data = await res.json() as OllamaChatResponse;
      const text = data.message?.content ?? ""; // Extract text from message.content

      // Try to parse the response as a ReviewResult JSON
      const parsed = safeJsonParse<ReviewResult | null>(text, null);

      // Valid ReviewResult must have a files array
      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles); // Bad/empty response → local fallback
    } catch {
      // Network error (Ollama not running) or any unexpected failure → local agent fallback
      // This is the most common failure mode — Ollama isn't installed or isn't running
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
