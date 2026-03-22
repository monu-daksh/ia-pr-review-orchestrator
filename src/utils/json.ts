/**
 * ============================================================
 * FILE: src/utils/json.ts
 * PURPOSE: Safe JSON parsing with a fallback value on failure.
 *
 * WHY THIS EXISTS:
 *   AI providers return raw text that is SUPPOSED to be JSON.
 *   In practice, it can fail to parse because:
 *     - The AI wrapped its response in markdown fences (```json ... ```)
 *     - The AI added preamble text before the JSON
 *     - The response was truncated due to token limits
 *     - The AI deviated from the requested format
 *
 *   Rather than crashing with a SyntaxError, safeJsonParse returns the
 *   provided fallback and lets the caller decide what to do next.
 *   All providers use this: if parsing fails, they run local pattern agents.
 *
 * USAGE:
 *   const parsed = safeJsonParse<ReviewResult | null>(text, null);
 *   if (!parsed || !Array.isArray(parsed.files)) {
 *     return runLocalAgentPipeline(triagedFiles); // fallback
 *   }
 * ============================================================
 */

/**
 * Parses a JSON string, returning `fallback` if parsing fails for any reason.
 *
 * @param text     - The string to parse as JSON
 * @param fallback - The value to return if parsing fails
 * @returns The parsed value (typed as T), or `fallback` on any parse error
 */
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text); // Attempt standard JSON parsing
  } catch {
    return fallback; // Parsing failed — return the safe fallback value
  }
}
