/**
 * ============================================================
 * FILE: src/providers/local-provider.ts
 * PURPOSE: Pattern-based fallback provider — works with NO AI, NO internet,
 *          and NO API keys. Always available as the final safety net.
 *
 * WHAT IT DOES:
 *   Delegates to runLocalAgentPipeline() in src/agents/local-agents.ts.
 *   That function runs 8 regex-based pattern agents synchronously:
 *     security, bug, logic, types, eslint, performance, best-practices, quality
 *
 * WHEN IS IT USED?
 *   Automatically selected when no AI provider is configured (no API keys).
 *   Also used as an INTERNAL FALLBACK by every AI provider:
 *     - AnthropicProvider → fallback if Claude call fails or returns no findings
 *     - GroqProvider      → fallback if Groq call fails
 *     - GeminiProvider    → fallback if Gemini call fails
 *     - OllamaProvider    → fallback if Ollama is unreachable
 *     - OpenAIProvider    → fallback if OpenAI call fails
 *     - MultiAgentProvider→ fallback if ALL 9 agents return zero findings
 *
 * WHAT IT DETECTS (without AI):
 *   Security:     dangerouslySetInnerHTML, SQL string interpolation
 *   Bug:          fetch() without await
 *   Logic:        db.query() without bound parameters
 *   Types:        catch(error) without : unknown annotation
 *   ESLint:       console.log/error, var keyword
 *   Performance:  .sort() or .reverse() in hot paths
 *   Best Practice:@ts-ignore usage, loose == equality
 *   Quality:      `any` type usage
 *
 * CONFIDENCE SCORES:
 *   Pattern agents have lower confidence (0.71–0.99) than AI agents (0.75–0.88)
 *   for most issues, but exact pattern matches (like SQL injection) can have
 *   confidence 0.99 — higher than any AI agent.
 *
 * NOTE: The promptPayload parameter is ignored — local agents work directly
 *       from the triaged file data (diff lines and full file content).
 * ============================================================
 */

import { runLocalAgentPipeline } from "../agents/local-agents.js";
import type { PromptPayload, ReviewResult, TriagedFile, ReviewProvider } from "../types.js";

export class LocalProvider implements ReviewProvider {
  /**
   * Runs the pattern-based local agent pipeline.
   * No AI calls, no network, no API keys required.
   *
   * @param _promptPayload - Ignored (local agents don't use prompts)
   * @param triagedFiles   - Files with diff content and risk triage
   * @returns ReviewResult from 8 pattern-based agents
   */
  async review(_promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult> {
    // runLocalAgentPipeline is synchronous internally but wrapped in async for interface compliance
    return runLocalAgentPipeline(triagedFiles);
  }
}
