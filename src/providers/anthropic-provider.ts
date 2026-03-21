/**
 * Anthropic / Claude Provider — Full review via the official Anthropic SDK
 *
 * This is the enterprise-grade provider for when your company is ready to pay.
 * Uses claude-opus-4-6 with adaptive thinking by default — the model decides
 * when and how much to think, giving superior results on complex security and
 * logic issues compared to any free provider.
 *
 * Features:
 *   - Adaptive thinking (claude-opus-4-6 / claude-sonnet-4-6)
 *   - Streaming for large responses (prevents timeout on long diffs)
 *   - Automatic retry with backoff via the SDK
 *   - Typed error handling
 *   - Falls back to local pattern agents on any failure
 *
 * Requires: npm install @anthropic-ai/sdk
 *
 * Env vars:
 *   ANTHROPIC_API_KEY  — required. Get at https://console.anthropic.com
 *   ANTHROPIC_MODEL    — optional. Default: claude-opus-4-6
 *                        Options (best → cheapest):
 *                          claude-opus-4-6   — highest quality + adaptive thinking
 *                          claude-sonnet-4-6 — balanced speed/quality
 *                          claude-haiku-4-5  — fastest, cheapest
 *
 * Pricing (per million tokens, as of 2025):
 *   claude-opus-4-6:   $5 input / $25 output
 *   claude-sonnet-4-6: $3 input / $15 output
 *   claude-haiku-4-5:  $1 input / $5  output
 */

import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

export class AnthropicProvider implements ReviewProvider {
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return runLocalAgentPipeline(triagedFiles);

    // Dynamic import — keeps @anthropic-ai/sdk optional until this provider is used
    let AnthropicSDK: typeof import("@anthropic-ai/sdk").default;
    try {
      ({ default: AnthropicSDK } = await import("@anthropic-ai/sdk"));
    } catch {
      // SDK not installed — fall back gracefully
      return runLocalAgentPipeline(triagedFiles);
    }

    const client = new AnthropicSDK({ apiKey });
    const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-6";

    // Adaptive thinking is supported on claude-opus-4-6 and claude-sonnet-4-6.
    // For haiku, thinking is ignored by the API, so it is safe to include always.
    const supportsThinking = model.includes("opus") || model.includes("sonnet");

    try {
      // Use streaming to handle large diffs without hitting HTTP timeouts.
      // finalMessage() collects the full response after the stream ends.
      //
      // Cast to `any` because the installed SDK typings only know
      // thinking.type "enabled"|"disabled" — "adaptive" was added to the API
      // later and the types lag behind. The API call itself is correct.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (client.messages.stream as any)({
        model,
        // 8192 for haiku, 16000 for sonnet/opus (thinking needs more room)
        max_tokens: supportsThinking ? 16000 : 8192,
        ...(supportsThinking ? { thinking: { type: "adaptive" } } : {}),
        system: promptPayload.system,
        messages: [
          {
            role: "user",
            content: JSON.stringify(promptPayload.user)
          }
        ]
      });

      const message = await stream.finalMessage();

      // The response may contain thinking blocks (internal reasoning) followed
      // by text blocks (the actual JSON response). We only want the text.
      const text = (message.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");

      const parsed = safeJsonParse<ReviewResult | null>(text, null);
      return parsed && Array.isArray(parsed.files)
        ? parsed
        : runLocalAgentPipeline(triagedFiles);
    } catch (error) {
      // Use the SDK's typed error classes when available, otherwise swallow
      if (AnthropicSDK && error instanceof (AnthropicSDK as unknown as { APIError: typeof Error }).APIError) {
        console.error("[AnthropicProvider] API error — falling back to local agents");
      }
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}
