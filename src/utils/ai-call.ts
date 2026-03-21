import { isConfiguredValue } from "./env.js";

/**
 * Generic AI caller — tries providers in priority order:
 *
 *   1. Claude / Anthropic  (ANTHROPIC_API_KEY) — claude-opus-4-6 + adaptive thinking
 *                                                 Best quality, paid
 *   2. Groq               (GROQ_API_KEY)       — Llama 3.3 70B, free tier, very fast
 *   3. Gemini             (GEMINI_API_KEY)     — Gemini 2.0 Flash, free tier, generous limits
 *   4. Ollama             (OLLAMA_HOST)        — local models, completely free, offline
 *   5. returns null → caller falls back to pattern-based agents
 *
 * All providers use the same message format and return plain text.
 * When your company is ready to pay for Anthropic, just add ANTHROPIC_API_KEY —
 * all 6 specialized agents automatically upgrade to Claude with no code changes.
 */

interface AIMessage {
  role: "system" | "user";
  content: string;
}

// ─── Anthropic REST response ──────────────────────────────────────────────────

interface AnthropicContent {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContent[];
}

// ─── OpenAI-compatible REST response (Groq, OpenAI) ──────────────────────────

interface OpenAICompatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// ─── Gemini REST response ─────────────────────────────────────────────────────

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

// ─── Ollama REST response ─────────────────────────────────────────────────────

interface OllamaResponse {
  message?: { content?: string };
}

// ─── Provider implementations ─────────────────────────────────────────────────

/**
 * Calls the Anthropic Messages API directly via fetch.
 * Uses claude-opus-4-6 with adaptive thinking for maximum quality.
 * Get API key at: https://console.anthropic.com
 *
 * Env vars: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional)
 * Recommended models by cost:
 *   claude-opus-4-6   — highest quality (default)
 *   claude-sonnet-4-6 — balanced speed/quality
 *   claude-haiku-4-5  — fastest, cheapest
 */
async function callClaude(messages: AIMessage[], maxTokens: number): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!isConfiguredValue(apiKey)) return null;
  const configuredApiKey = apiKey as string;

  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-6";
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
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Adaptive thinking: Claude decides when and how much to think.
        // Works on claude-opus-4-6 and claude-sonnet-4-6. Ignored on Haiku.
        thinking: { type: "adaptive" },
        system: systemText,
        messages: userMessages
      })
    });

    if (!res.ok) return null;
    const data = await res.json() as AnthropicResponse;

    // Response may contain thinking blocks + text blocks — extract text only
    return (
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("") ?? null
    );
  } catch {
    return null;
  }
}

async function callGroq(messages: AIMessage[], maxTokens: number): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!isConfiguredValue(apiKey)) return null;
  const configuredApiKey = apiKey as string;

  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${configuredApiKey}`
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.1 })
    });

    if (!res.ok) return null;
    const data = await res.json() as OpenAICompatResponse;
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

async function callGemini(messages: AIMessage[], maxTokens: number): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!isConfiguredValue(apiKey)) return null;
  const configuredApiKey = apiKey as string;

  const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  const systemText = messages.find((m) => m.role === "system")?.content ?? "";
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${configuredApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents: [{ parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.1 }
      })
    });

    if (!res.ok) return null;
    const data = await res.json() as GeminiResponse;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

async function callOllama(messages: AIMessage[], maxTokens: number): Promise<string | null> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.2";

  try {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, options: { num_predict: maxTokens } })
    });

    if (!res.ok) return null;
    const data = await res.json() as OllamaResponse;
    return data.message?.content ?? null;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Calls the best available AI provider in priority order.
 * Returns the raw text response, or null if no provider is configured.
 *
 * Priority: Claude (ANTHROPIC_API_KEY) → Groq → Gemini → Ollama → null
 */
export async function callAI(system: string, user: string, maxTokens = 1200): Promise<string | null> {
  const messages: AIMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  return (
    await callClaude(messages, maxTokens) ??
    await callGroq(messages, maxTokens) ??
    await callGemini(messages, maxTokens) ??
    await callOllama(messages, maxTokens) ??
    null
  );
}

/** Returns which AI provider is currently configured, for diagnostics. */
export function detectAvailableAI(): "claude" | "groq" | "gemini" | "ollama" | "none" {
  if (isConfiguredValue(process.env.ANTHROPIC_API_KEY)) return "claude";
  if (isConfiguredValue(process.env.GROQ_API_KEY)) return "groq";
  if (isConfiguredValue(process.env.GEMINI_API_KEY)) return "gemini";
  if (isConfiguredValue(process.env.OLLAMA_HOST)) return "ollama";
  return "none";
}

