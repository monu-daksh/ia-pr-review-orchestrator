/**
 * ============================================================
 * FILE: src/providers/anthropic-provider.ts
 * PURPOSE: Enterprise-grade Claude provider using the official Anthropic SDK.
 *          Uses streaming + adaptive thinking for the highest quality reviews.
 *
 * WHEN TO USE THIS vs. multi-agent:
 *   This sends ONE combined prompt to Claude.
 *   Multi-agent mode (triggered by ANTHROPIC_API_KEY) is usually BETTER because
 *   it runs 9 specialized agents in parallel using Claude for each.
 *   Use this if you set PR_REVIEW_PROVIDER=claude explicitly.
 *
 * KEY FEATURES:
 *   Adaptive thinking   — Claude decides when and how much internal reasoning to do.
 *                         Produces superior results on complex security/logic issues.
 *                         Enabled on claude-opus-4-6 and claude-sonnet-4-6.
 *   Streaming           — Prevents HTTP timeouts on large diffs. The stream is
 *                         collected and the final message is used.
 *   Auto retry          — Built into the Anthropic SDK with exponential backoff.
 *   Typed error handling— SDK provides typed APIError class for specific error handling.
 *
 * FALLBACK:
 *   Any failure → local pattern agents (runLocalAgentPipeline).
 *   The review ALWAYS returns a result — never throws.
 *
 * ENV VARS:
 *   ANTHROPIC_API_KEY  — required (get at https://console.anthropic.com)
 *   ANTHROPIC_MODEL    — optional (default: claude-opus-4-6)
 *                        claude-opus-4-6   — highest quality + adaptive thinking ($5/$25 per M tokens)
 *                        claude-sonnet-4-6 — balanced speed/quality ($3/$15 per M tokens)
 *                        claude-haiku-4-5  — fastest, cheapest ($1/$5 per M tokens)
 *
 * INSTALL: npm install @anthropic-ai/sdk
 *   The SDK is optional and loaded dynamically. If not installed, falls back to local agents.
 * ============================================================
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

export class AnthropicProvider implements ReviewProvider {
  /**
   * Reviews changed files using the Anthropic Claude API.
   * Uses streaming to handle large diffs without HTTP timeouts.
   *
   * @param promptPayload - System prompt + review instructions + file content
   * @param triagedFiles  - Used for local agent fallback if Claude fails
   * @returns ReviewResult from Claude, or local pattern agent fallback
   */
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    // No API key → immediately use local pattern agents
    if (!apiKey) return runLocalAgentPipeline(triagedFiles);

    // Dynamic import — keeps @anthropic-ai/sdk optional.
    // If not installed, falls back gracefully instead of crashing at startup.
    let AnthropicSDK: typeof import("@anthropic-ai/sdk").default;
    try {
      ({ default: AnthropicSDK } = await import("@anthropic-ai/sdk"));
    } catch {
      // SDK not installed → fall back to local pattern agents
      return runLocalAgentPipeline(triagedFiles);
    }

    const client = new AnthropicSDK({ apiKey });
    const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-6"; // Default to highest quality

    // Adaptive thinking is supported on claude-opus-4-6 and claude-sonnet-4-6.
    // For haiku, the thinking field is silently ignored by the API.
    const supportsThinking = model.includes("opus") || model.includes("sonnet");

    try {
      // Use streaming to handle large diffs without hitting HTTP timeouts.
      // finalMessage() waits for the complete stream and returns the full response.
      //
      // Cast to `any` because the installed SDK typings only know
      // thinking.type "enabled"|"disabled" — the "adaptive" value was added to
      // the API after these types were published and lags behind. The API call itself is correct.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (client.messages.stream as any)({
        model,
        // Larger token budget for models that support thinking (needs extra room for reasoning)
        max_tokens: supportsThinking ? 16000 : 8192,
        // Only add thinking config for models that support it
        ...(supportsThinking ? { thinking: { type: "adaptive" } } : {}),
        system: promptPayload.system,                       // AI persona + output schema
        messages: [
          {
            role: "user",
            content: JSON.stringify(promptPayload.user)     // Review instructions + files
          }
        ]
      });

      // Wait for the stream to complete and get the final collected message
      const message = await stream.finalMessage();

      // Response may contain "thinking" blocks (internal reasoning) and "text" blocks.
      // We only want the text blocks — the "thinking" blocks are Claude's scratch pad.
      const text = (message.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === "text")     // Only text blocks (not thinking)
        .map((block) => block.text ?? "")             // Extract text string
        .join("");                                     // Join multiple text blocks

      // Parse the response as a ReviewResult JSON
      const parsed = safeJsonParse<ReviewResult | null>(text, null);

      // Valid ReviewResult must have a files array
      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles); // Bad response → local fallback
    } catch (error) {
      // Log Claude-specific API errors using the SDK's typed error class
      if (AnthropicSDK && error instanceof (AnthropicSDK as unknown as { APIError: typeof Error }).APIError) {
        console.error("[AnthropicProvider] API error — falling back to local agents");
      }
      // Any error → local pattern agent fallback
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
