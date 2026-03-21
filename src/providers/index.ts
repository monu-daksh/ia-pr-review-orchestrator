/**
 * Provider factory.
 *
 * ── Provider names ──────────────────────────────────────────────────────────
 *
 *   multi-agent  — 6 AI-powered specialized agents, each with a focused prompt.
 *                  Auto-picks the best available AI (Claude → Groq → Gemini →
 *                  Ollama → pattern fallback). This is the recommended mode.
 *
 *   claude       — Single LLM call via Anthropic Claude (paid, highest quality)
 *                  Uses claude-opus-4-6 + adaptive thinking by default.
 *
 *   groq         — Single LLM call via Groq API (free tier, Llama 3.3 70B)
 *   gemini       — Single LLM call via Google Gemini Flash (free tier)
 *   ollama       — Single LLM call via local Ollama instance (completely free)
 *   openai       — Single LLM call via OpenAI API (paid)
 *   local        — Pattern-based agents only — no AI, always works
 *
 * ── Auto-detection (when PR_REVIEW_PROVIDER is not set) ────────────────────
 *
 *   ANTHROPIC_API_KEY set → "multi-agent" (powered by Claude)
 *   GROQ_API_KEY set      → "multi-agent" (powered by Groq, free)
 *   GEMINI_API_KEY set    → "multi-agent" (powered by Gemini, free)
 *   OLLAMA_HOST set       → "multi-agent" (powered by local Ollama, free)
 *   OPENAI_API_KEY set    → "openai"
 *   nothing set           → "local"     (pattern-based, no AI)
 *
 * ── Upgrade path ────────────────────────────────────────────────────────────
 *
 *   Phase 1 (now):   GROQ_API_KEY or GEMINI_API_KEY   → free AI agents
 *   Phase 2 (later): ANTHROPIC_API_KEY                 → Claude-powered agents
 *   No code changes needed — just add the key.
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

function autoDetectProvider(): string {
  if (isConfiguredValue(process.env.ANTHROPIC_API_KEY)) return "multi-agent"; // Claude powers agents
  if (isConfiguredValue(process.env.GROQ_API_KEY)) return "multi-agent";      // Groq powers agents (free)
  if (isConfiguredValue(process.env.GEMINI_API_KEY)) return "multi-agent";    // Gemini powers agents (free)
  if (isConfiguredValue(process.env.OLLAMA_HOST)) return "multi-agent";       // Ollama powers agents (local)
  if (isConfiguredValue(process.env.OPENAI_API_KEY)) return "openai";
  return "local";
}

export function createProvider(explicitProvider?: string): ReviewProvider {
  const name = explicitProvider ?? process.env.PR_REVIEW_PROVIDER ?? autoDetectProvider();

  switch (name) {
    case "multi-agent": return new MultiAgentProvider();
    case "claude":      return new AnthropicProvider();
    case "groq":        return new GroqProvider();
    case "gemini":      return new GeminiProvider();
    case "ollama":      return new OllamaProvider();
    case "openai":      return new OpenAIProvider();
    default:            return new LocalProvider();
  }
}
