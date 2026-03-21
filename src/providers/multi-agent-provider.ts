/**
 * Multi-Agent Provider — wraps the AI-powered multi-agent pipeline.
 *
 * This is the recommended free provider. Each of the 6 specialized agents
 * (security, bug, logic, types, eslint, quality) runs in parallel with its
 * own focused system prompt, using whatever free AI is available:
 *   Groq (GROQ_API_KEY) → Gemini (GEMINI_API_KEY) → Ollama (OLLAMA_HOST) → patterns
 */

import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runAIAgentPipeline } from "../agents/ai-agents.js";

export class MultiAgentProvider implements ReviewProvider {
  async review(_promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    return runAIAgentPipeline(triagedFiles);
  }
}
