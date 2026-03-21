import { runLocalAgentPipeline } from "../agents/local-agents.js";
import type { PromptPayload, ReviewResult, TriagedFile, ReviewProvider } from "../types.js";

export class LocalProvider implements ReviewProvider {
  async review(_promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    return runLocalAgentPipeline(triagedFiles);
  }
}

