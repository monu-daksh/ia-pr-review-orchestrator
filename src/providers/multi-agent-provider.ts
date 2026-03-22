/**
 * ============================================================
 * FILE: src/providers/multi-agent-provider.ts
 * PURPOSE: Thin wrapper that routes to the AI-powered multi-agent pipeline.
 *          This is the RECOMMENDED provider for most setups.
 *
 * WHAT IT DOES:
 *   Delegates to runAIAgentPipeline() in src/agents/ai-agents.ts.
 *   That function runs 9 specialized agents in parallel, each with a
 *   focused system prompt and confidence score:
 *     security, bug, logic, types, eslint, performance, best-practices, quality
 *
 * WHY MULTI-AGENT?
 *   A single large AI call often misses issues because the model spreads
 *   attention across all concern types at once.
 *   Specialized agents perform better because:
 *     - Security agent only thinks about security — no distraction from style
 *     - Bug agent only thinks about runtime bugs — no distraction from types
 *     - Each agent has a precise, focused prompt with mandatory patterns to report
 *   Running them in parallel (Promise.all) means no extra latency vs single-call.
 *
 * FALLBACK:
 *   If ALL agents return zero findings, the pipeline automatically falls back
 *   to local pattern-based agents (runLocalAgentPipeline).
 *   This ensures something is always returned even if the AI fails.
 *
 * AI BACKEND:
 *   Each agent calls callAI() from utils/ai-call.ts.
 *   callAI() tries: Claude → Groq → Gemini → Ollama → null
 *   If null, the agent returns [] and the fallback kicks in.
 *
 * NOTE: The promptPayload parameter is ignored here — multi-agent mode
 *       builds its own per-agent prompts from the triagedFiles directly.
 *       The prompt payload is only used by single-call providers.
 * ============================================================
 */

import type { PromptPayload, ReviewProvider, ReviewResult, TriagedFile } from "../types.js";
import { runAIAgentPipeline } from "../agents/ai-agents.js";

export class MultiAgentProvider implements ReviewProvider {
  /**
   * Runs the AI-powered multi-agent pipeline.
   *
   * @param _promptPayload - Ignored (multi-agent builds its own prompts per agent)
   * @param triagedFiles   - Files with diff content and risk triage
   * @returns ReviewResult from 9 specialized AI agents (or local pattern fallback)
   */
  async review(_promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    // Delegate entirely to the AI agent pipeline
    // The pipeline handles: parallel execution, per-agent prompts, fallback to local agents
    return runAIAgentPipeline(triagedFiles);
  }
}
