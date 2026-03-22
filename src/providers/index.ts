/**
 * ============================================================
 * FILE: src/providers/index.ts
 * PURPOSE: Provider factory — creates the right AI provider based on
 *          available API keys and configuration.
 *
 * ── What is a Provider? ─────────────────────────────────────────────────────
 * A provider is a class that implements the ReviewProvider interface:
 *   review(promptPayload, triagedFiles) → Promise<ReviewResult>
 *
 * Each provider connects to a different AI backend. They all return the
 * same ReviewResult shape, so the rest of the system doesn't care which one ran.
 *
 * ── Provider Names ───────────────────────────────────────────────────────────
 *
 *   multi-agent  — RECOMMENDED. 9 specialized AI agents run in parallel, each
 *                  with a focused system prompt. Auto-picks the best available AI:
 *                  Claude → Groq → Gemini → Ollama → pattern fallback.
 *
 *   claude       — Single LLM call via Anthropic Claude SDK (paid, highest quality)
 *                  Uses claude-opus-4-6 + adaptive thinking.
 *
 *   groq         — Single LLM call via Groq API REST (free tier, Llama 3.3 70B)
 *   gemini       — Single LLM call via Google Gemini Flash REST (free tier)
 *   ollama       — Single LLM call via local Ollama instance (completely free)
 *   openai       — Single LLM call via OpenAI API SDK (paid)
 *   local        — Pattern-based regex agents only — NO AI, always works offline
 *
 * ── Auto-Detection (when PR_REVIEW_PROVIDER is not set) ─────────────────────
 *
 *   ANTHROPIC_API_KEY set → "multi-agent" (powered by Claude)
 *   GROQ_API_KEY set      → "multi-agent" (powered by Groq, free)
 *   GEMINI_API_KEY set    → "multi-agent" (powered by Gemini, free)
 *   OLLAMA_HOST set       → "multi-agent" (powered by local Ollama, free)
 *   OPENAI_API_KEY set    → "openai" (single-call mode for OpenAI)
 *   nothing set           → "local" (pattern-based agents, no AI)
 *
 * ── Upgrade Path ─────────────────────────────────────────────────────────────
 *
 *   Phase 1 (now):   Start with GROQ_API_KEY or GEMINI_API_KEY for free AI agents
 *   Phase 2 (later): Add ANTHROPIC_API_KEY to upgrade to Claude — no code changes needed
 *   Phase 3 (prod):  Set PR_REVIEW_PROVIDER=multi-agent explicitly in CI config
 *
 * ── Fallback Behavior ────────────────────────────────────────────────────────
 *
 *   Every provider catches errors internally and falls back to local pattern agents.
 *   The local provider is the final safety net that never fails.
 *   The system always returns a valid ReviewResult — never throws.
 * ============================================================
 */

import { OpenAIProvider } from "./openai-provider.js";
import { LocalProvider } from "./local-provider.js";
import { GroqProvider } from "./groq-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { MultiAgentProvider } from "./multi-agent-provider.js";
import type { ReviewProvider } from "../types.js";
import { isConfiguredValue } from "../utils/env.js";

/**
 * Auto-detects which provider to use based on which API keys are configured.
 * Called when no explicit provider override is set.
 *
 * Priority logic:
 *   Claude, Groq, Gemini, and Ollama all use "multi-agent" mode — the specialized
 *   9-agent pipeline is better than a single call for all of these.
 *   OpenAI uses its own single-call mode (different SDK pattern).
 *   Nothing configured → "local" (pattern-based, works everywhere).
 *
 * @returns The name of the provider to use
 */
function autoDetectProvider(): string {
  if (isConfiguredValue(process.env.ANTHROPIC_API_KEY)) return "multi-agent"; // Claude powers 9 agents
  if (isConfiguredValue(process.env.GROQ_API_KEY)) return "multi-agent";      // Groq powers agents (free tier)
  if (isConfiguredValue(process.env.GEMINI_API_KEY)) return "multi-agent";    // Gemini powers agents (free tier)
  if (isConfiguredValue(process.env.OLLAMA_HOST)) return "multi-agent";       // Local Ollama powers agents
  if (isConfiguredValue(process.env.OPENAI_API_KEY)) return "openai";         // OpenAI gets its own mode
  return "local"; // No AI configured → fall back to pattern-based local agents
}

/**
 * Creates and returns the appropriate ReviewProvider instance.
 *
 * Provider selection priority:
 *   1. `explicitProvider` argument (from CLI --provider flag or options.provider)
 *   2. `PR_REVIEW_PROVIDER` environment variable
 *   3. Auto-detection based on available API keys
 *
 * @param explicitProvider - Optional provider name to use instead of auto-detection
 * @returns A ReviewProvider instance ready to call .review()
 */
export function createProvider(explicitProvider?: string): ReviewProvider {
  // Determine which provider to use: explicit override → env var → auto-detect
  const name = explicitProvider ?? process.env.PR_REVIEW_PROVIDER ?? autoDetectProvider();

  switch (name) {
    // Multi-agent mode: 9 specialized AI agents running in parallel
    case "multi-agent": return new MultiAgentProvider();

    // Single-call providers: one big prompt to one AI
    case "claude":      return new AnthropicProvider();  // Claude via @anthropic-ai/sdk
    case "groq":        return new GroqProvider();        // Groq via REST API
    case "gemini":      return new GeminiProvider();      // Google Gemini via REST API
    case "ollama":      return new OllamaProvider();      // Local Ollama via REST API
    case "openai":      return new OpenAIProvider();      // OpenAI via openai SDK

    // Default fallback: pattern-based agents with no AI (always works offline)
    default:            return new LocalProvider();
  }
}
