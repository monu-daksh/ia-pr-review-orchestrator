import { createEmptyReview } from "../core/schema.js";
import { safeJsonParse } from "../utils/json.js";
import type { PromptPayload, ReviewResult, TriagedFile, ReviewProvider } from "../types.js";
import { runLocalAgentPipeline } from "../agents/local-agents.js";

export class OpenAIProvider implements ReviewProvider {
  async review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    let OpenAI: typeof import("openai").default;
    try {
      ({ default: OpenAI } = await import("openai"));
    } catch {
      return runLocalAgentPipeline(triagedFiles);
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    try {
      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: promptPayload.system }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(promptPayload.user) }]
          }
        ]
      });

      const text = response.output_text || "";
      const parsed = safeJsonParse<ReviewResult | null>(text, null);
      return parsed && Array.isArray(parsed.files) ? parsed : runLocalAgentPipeline(triagedFiles);
    } catch {
      return runLocalAgentPipeline(triagedFiles);
    }
  }
}

