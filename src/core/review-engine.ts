/**
 * ============================================================
 * FILE: src/core/review-engine.ts
 * PURPOSE: Main orchestrator — the single entry point for reviewing a diff.
 *          Called by the CLI (src/cli.ts) and by library consumers.
 *
 * FLOW:
 *   1. Load env files (API keys, provider config)
 *   2. Parse the unified diff text → array of ParsedDiffFile
 *   3. Enrich each file by reading full content from disk (gives AI more context)
 *   4. Triage each file (detect risk level and areas of concern)
 *   5. If --dry-run: return parsed files + prompt payload (no AI call)
 *   6. Auto-select or use the requested provider
 *   7. Build prompt payload → send to provider → get ReviewResult
 *   8. Normalize the result (attach triage, fill missing fields)
 *   9. Finalize: deduplicate, count severities, build markdown summary
 *
 * FALLBACK CHAIN:
 *   If provider is null or returns invalid results → createEmptyReview() (approve)
 *   Each provider itself falls back to local pattern agents on any error
 * ============================================================
 */

import { parseUnifiedDiff } from "./diff-parser.js";
import { buildPromptPayload } from "./prompt-builder.js";
import { createEmptyReview, finalizeSummary } from "./schema.js";
import { triageFile } from "./triage.js";
import { createProvider } from "../providers/index.js";
import type { DryRunResult, ReviewOptions, ReviewResult, TriagedFile } from "../types.js";
import { loadProjectEnv } from "../utils/env.js";
import { readWorkingTreeFileLines } from "../utils/fs.js";

/**
 * Reviews a unified diff and returns a structured ReviewResult (or DryRunResult).
 *
 * @param diffText - Raw unified diff string (e.g., output of `git diff`)
 * @param options  - Optional configuration:
 *                     dryRun   → skip AI, return parsed files + prompt only
 *                     provider → force a specific provider (overrides auto-detect)
 *                     format   → "json" | "github-pr" (handled by CLI, not here)
 * @returns ReviewResult (normal) or DryRunResult (if dryRun is true)
 */
export async function reviewDiff(diffText: string, options: ReviewOptions = {}): Promise<ReviewResult | DryRunResult> {
  // Step 1: Load all .env files and config JSONs from the project directory.
  // This sets process.env keys like ANTHROPIC_API_KEY, PR_REVIEW_PROVIDER, etc.
  await loadProjectEnv();

  // Step 2: Parse the unified diff into structured file objects.
  // Each ParsedDiffFile has the added lines, context lines, and language info.
  const parsedFiles = parseUnifiedDiff(diffText);

  // Step 3: Enrich each parsed file by reading its full current content from disk.
  // This gives AI agents the full file — not just the changed lines — so they can
  // catch pre-existing issues in the same file that was touched by the PR.
  const enrichedFiles = await Promise.all(
    parsedFiles.map(async (file) => ({
      ...file,
      fullFileLines: await readWorkingTreeFileLines(file.file) // Empty array if file not found
    }))
  );

  // Step 4: Triage each file to assign risk level and areas of concern.
  // High-risk files (auth, db, crypto, env) get priority attention from agents.
  const triaged: TriagedFile[] = enrichedFiles.map((file) => ({
    ...file,
    triage: triageFile(file)
  }));

  // Step 5: Dry-run mode — return parsed data + prompt payload without calling AI.
  // Useful for debugging: shows what the diff parsed to and what would be sent to AI.
  if (options.dryRun) {
    return {
      parsed_files: triaged,
      prompt_payload: buildPromptPayload(triaged)
    };
  }

  // Step 6: Create the appropriate provider based on available API keys or explicit override.
  // Priority (auto): Claude → Groq → Gemini → Ollama → OpenAI → local patterns
  // Override: set options.provider or PR_REVIEW_PROVIDER env var
  const provider = createProvider(options.provider);

  // If no provider could be created (should not happen — local is the final fallback),
  // return an empty review (all files approved, no findings).
  if (!provider) {
    const empty = createEmptyReview(triaged);
    // Attach triage results so the output still has risk level info
    empty.files.forEach((file, index) => {
      file.triage = triaged[index].triage;
    });
    return finalizeSummary(empty);
  }

  // Step 7: Build the prompt payload and send it to the provider.
  // The payload bundles system prompt + review instructions + file content.
  const promptPayload = buildPromptPayload(triaged);
  const result = await provider.review(promptPayload, triaged);

  // Step 8: Validate the provider result — if it returned nothing useful,
  // fall back to an empty review (approve) rather than throwing.
  if (!result || !Array.isArray(result.files)) {
    const empty = createEmptyReview(triaged);
    empty.files.forEach((file, index) => {
      file.triage = triaged[index].triage;
    });
    return finalizeSummary(empty);
  }

  // Step 9: Normalize the result.
  // - Ensure every file in the triaged list has a corresponding result entry
  // - Attach the correct file path, language, changed_lines, and triage from our data
  //   (the AI may have returned these slightly differently or in wrong order)
  result.files = triaged.map((file, index) => ({
    ...(result.files[index] ?? createEmptyReview([file]).files[0]), // Use AI result or empty
    file: file.file,                          // Always use our parsed file path (authoritative)
    language: file.language,                  // Always use our detected language
    changed_lines: result.files[index]?.changed_lines ?? file.addedLines.map((line) => line.line),
    triage: result.files[index]?.triage ?? file.triage  // Prefer AI triage if present
  }));

  // Step 10: Deduplicate findings, count severities, decide approve/request_changes,
  // build pr_comments, findings list, file summaries, and markdown summary.
  return finalizeSummary(result);
}
