/**
 * ============================================================
 * FILE: src/utils/ai-call.ts
 * PURPOSE: Generic AI caller used by the multi-agent pipeline (ai-agents.ts).
 *          Tries AI providers in priority order and returns the first
 *          successful response as plain text.
 *
 * PRIORITY ORDER:
 *   1. Claude (ANTHROPIC_API_KEY)  — claude-opus-4-6 + adaptive thinking, best quality, paid
 *   2. Groq   (GROQ_API_KEY)      — Llama 3.3 70B, free tier, very fast, 30 req/min
 *   3. Gemini (GEMINI_API_KEY)    — Gemini 2.0 Flash, free tier, 15 RPM, 1M tokens/day
 *   4. Ollama (OLLAMA_HOST)       — local models, completely free, offline-capable
 *   5. null                       — no AI available, caller falls back to pattern agents
 *
 * HOW IT'S USED:
 *   Each AI agent in ai-agents.ts calls callAI(systemPrompt, userContent, maxTokens).
 *   The best available AI handles the request.
 *   If the call fails or no API key is set, returns null — agents fall back to local patterns.
 *
 * UPGRADE PATH:
 *   Start with GROQ_API_KEY (free) → all 9 agents get Llama 3.3.
 *   Later add ANTHROPIC_API_KEY → all agents automatically upgrade to Claude.
 *   No code changes needed — just add the env var.
 * ============================================================
 */

import { isConfiguredValue } from "./env.js";

// ─── Message Format ───────────────────────────────────────────────────────────

/**
 * Standard message format used internally.
 * All providers accept system + user message pairs.
 */
interface AIMessage {
  role: "system" | "user"; // "system" for AI persona, "user" for the review request
  content: string;          // The message text
}

// ─── Response Type Definitions ────────────────────────────────────────────────

/**
 * Anthropic API response shape.
 * The `content` array may contain both "thinking" blocks (internal reasoning)
 * and "text" blocks (the actual response). We only extract "text" blocks.
 */
interface AnthropicContent {
  type: string;  // "thinking" or "text"
  text?: string; // The text content (only present on type="text")
}

interface AnthropicResponse {
  content?: AnthropicContent[]; // Array of response blocks
}

/**
 * OpenAI-compatible response shape.
 * Used by Groq (which is OpenAI API-compatible).
 * The response text is at choices[0].message.content.
 */
interface OpenAICompatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Google Gemini API response shape.
 * The response text is nested inside candidates[0].content.parts[0].text.
 */
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/**
 * Ollama chat API response shape.
 * Much simpler than cloud providers — just message.content.
 */
interface OllamaResponse {
  message?: { content?: string };
}

// ─── Provider Implementations ─────────────────────────────────────────────────

/**
 * Calls the Anthropic Messages API directly via fetch (no SDK).
 * Uses claude-opus-4-6 with adaptive thinking for maximum review quality.
 *
 * Adaptive thinking: Claude decides when and how much internal reasoning to do.
 * Works on claude-opus-4-6 and claude-sonnet-4-6.
 * Haiku silently ignores the thinking field.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY  — required (get at https://console.anthropic.com)
 *   ANTHROPIC_MODEL    — optional (default: claude-opus-4-6)
 *
 * @returns The text response string, or null if API key missing or request failed
 */
async function callClaude(messages: AIMessage[], maxTokens: number): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!isConfiguredValue(apiKey)) return null; // No key configured → skip this provider
  const configuredApiKey = apiKey as string;

  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-6"; // Default to highest quality model

  // Extract system and user messages from the messages array
  const systemText = messages.find((m) => m.role === "system")?.content ?? "";
  const userMessages = messages
    .filter((m) => m.role === "user")
    .map((m) => ({ role: "user" as const, content: m.content }));

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": configuredApiKey,
        "anthropic-version": "2023-06-01" // Required header for Anthropic API versioning
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Adaptive thinking: Claude decides when and how much to think.
        // Produces higher quality on complex security/logic analysis.
        thinking: { type: "adaptive" },
        system: systemText,
        messages: userMessages
      })
    });

    if (!res.ok) return null; // API error (rate limit, auth failure, etc.)

    const data = await res.json() as AnthropicResponse;

    // Extract only "text" blocks — ignore "thinking" blocks (internal reasoning)
    return (
      data.content
        ?.filter((b) => b.type === "text")  // Only text blocks (not thinking)
        .map((b) => b.text ?? "")           // Extract text string
        .join("") ?? null                   // Join multiple text blocks
    );
  } catch {
    return null; // Network error or JSON parse failure → fall through to next provider
  }
}

/**
 * Calls the Groq API using their OpenAI-compatible endpoint.
 * Free tier: 30 requests/minute, 14,400 req/day, Llama 3.3 70B model.
 * Very fast — Groq uses custom hardware for inference.
 *
 * Env vars:
 *   GROQ_API_KEY  — required (get at https://console.groq.com)
 *   GROQ_MODEL    — optional (default: llama-3.3-70b-versatile)
 *
 * @returns The text response string, or null if API key missing or request failed
 */
async function callGroq(messages: AIMessage[], maxTokens: number): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!isConfiguredValue(apiKey)) return null; // No key → skip
  const configuredApiKey = apiKey as string;

  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile"; // Best free Groq model

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${configuredApiKey}` // Groq uses Bearer token auth
      },
      // temperature: 0.1 keeps responses deterministic and JSON-friendly
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.1 })
    });

    if (!res.ok) return null;

    const data = await res.json() as OpenAICompatResponse;
    return data.choices?.[0]?.message?.content ?? null; // Extract text from first choice
  } catch {
    return null;
  }
}

/**
 * Calls the Google Gemini API via REST (no SDK required).
 * Free tier: 15 requests/minute, 1,000,000 tokens/day, 1,500 req/day.
 *
 * Env vars:
 *   GEMINI_API_KEY  — required (get at https://aistudio.google.com/apikey)
 *   GEMINI_MODEL    — optional (default: gemini-2.0-flash)
 *
 * Note: Gemini uses a different message format than OpenAI-compat providers.
 * System instruction and user content are sent separately.
 *
 * @returns The text response string, or null if API key missing or request failed
 */
async function callGemini(messages: AIMessage[], maxTokens: number): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!isConfiguredValue(apiKey)) return null; // No key → skip
  const configuredApiKey = apiKey as string;

  const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash"; // Fast, generous free limits

  // Extract system and user text from the messages array
  const systemText = messages.find((m) => m.role === "system")?.content ?? "";
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");

  try {
    // Gemini API URL includes model name and API key as query parameter
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${configuredApiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] }, // Gemini's system message format
        contents: [{ parts: [{ text: userText }] }],           // User message format
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.1 }
      })
    });

    if (!res.ok) return null;

    const data = await res.json() as GeminiResponse;
    // Gemini nests the text deep: candidates[0].content.parts[0].text
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

/**
 * Calls a locally running Ollama instance.
 * Completely free, offline-capable, no API key required.
 * Requires Ollama installed and a model pulled first.
 *
 * Install: https://ollama.com
 * Good models: `ollama pull codellama` or `ollama pull llama3.2`
 *
 * Env vars:
 *   OLLAMA_HOST   — optional (default: http://localhost:11434)
 *   OLLAMA_MODEL  — optional (default: llama3.2)
 *
 * Note: This provider always attempts to connect (no API key check).
 * Returns null if Ollama is not running or the model isn't available.
 *
 * @returns The text response string, or null if Ollama unreachable or model unavailable
 */
async function callOllama(messages: AIMessage[], maxTokens: number): Promise<string | null> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434"; // Default local endpoint
  const model = process.env.OLLAMA_MODEL ?? "llama3.2";             // Default to llama3.2

  try {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,          // Ollama uses the same messages format as OpenAI
        stream: false,     // Disable streaming — we want the full response at once
        options: { num_predict: maxTokens } // Ollama's token limit parameter
      })
    });

    if (!res.ok) return null;

    const data = await res.json() as OllamaResponse;
    return data.message?.content ?? null; // Extract text from message.content
  } catch {
    return null; // Ollama not running or model not available → fall through
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Calls the best available AI provider in priority order.
 * Returns the raw text response from the first provider that succeeds.
 * Returns null if no provider is configured or all fail.
 *
 * Priority: Claude → Groq → Gemini → Ollama → null
 *
 * Used by every AI agent in ai-agents.ts. Agents pass their specific
 * system prompt and the file content, and get back raw JSON text.
 *
 * @param system    - The agent's system prompt (persona and instructions)
 * @param user      - The user content (file code and context to review)
 * @param maxTokens - Maximum response tokens (different per agent based on scope)
 * @returns Raw text from the AI, or null if all providers failed
 */
export async function callAI(system: string, user: string, maxTokens = 1200): Promise<string | null> {
  const messages: AIMessage[] = [
    { role: "system", content: system }, // Agent persona and instructions
    { role: "user", content: user }      // File content and code to review
  ];

  // Try providers in priority order — use ?? to fall through on null
  return (
    await callClaude(messages, maxTokens) ??   // Try Claude first (best quality, paid)
    await callGroq(messages, maxTokens) ??     // Try Groq second (free, fast)
    await callGemini(messages, maxTokens) ??   // Try Gemini third (free, generous limits)
    await callOllama(messages, maxTokens) ??   // Try local Ollama (completely free, offline)
    null                                        // No provider available → caller uses local patterns
  );
}

/**
 * Returns which AI provider is currently configured.
 * Useful for diagnostics, CI logs, and the `init` command output.
 *
 * @returns The name of the configured provider, or "none" if no AI is available
 */
export function detectAvailableAI(): "claude" | "groq" | "gemini" | "ollama" | "none" {
  if (isConfiguredValue(process.env.ANTHROPIC_API_KEY)) return "claude";
  if (isConfiguredValue(process.env.GROQ_API_KEY)) return "groq";
  if (isConfiguredValue(process.env.GEMINI_API_KEY)) return "gemini";
  if (isConfiguredValue(process.env.OLLAMA_HOST)) return "ollama";
  return "none"; // No AI configured — system will use local pattern agents
}
