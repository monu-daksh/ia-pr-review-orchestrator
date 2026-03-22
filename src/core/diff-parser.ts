/**
 * ============================================================
 * FILE: src/core/diff-parser.ts
 * PURPOSE: Parses a unified diff string into structured file objects.
 *          Converts raw `git diff` or `git diff HEAD` output into
 *          typed ParsedDiffFile[] that agents and providers can work with.
 *
 * UNIFIED DIFF FORMAT:
 *   diff --git a/src/foo.ts b/src/foo.ts   ← new file boundary
 *   --- a/src/foo.ts
 *   +++ b/src/foo.ts                        ← authoritative file path
 *   @@ -10,6 +10,8 @@                      ← hunk header (line numbers)
 *    context line (unchanged)               ← space prefix
 *   -removed line                           ← minus prefix (skipped)
 *   +added line                             ← plus prefix (captured)
 *
 * OUTPUT: ParsedDiffFile[] where each entry has:
 *   addedLines    → lines added in this PR (used for AI review focus)
 *   contextLines  → unchanged surrounding lines (for context only)
 *   language      → detected from file extension (e.g., "TypeScript")
 *   changeType    → "logic" | "config" | "dependency"
 * ============================================================
 */

import { detectLanguage } from "../config/language-profiles.js";
import type { ParsedDiffFile } from "../types.js";

/**
 * Creates an empty ParsedDiffFile shell for a given file path.
 * Language and change type are detected from the file extension using language profiles.
 * This is called when we first encounter a `diff --git` line.
 */
function createEmptyFile(filePath: string): ParsedDiffFile {
  const profile = detectLanguage(filePath); // Detect language from extension
  return {
    file: filePath,
    language: profile.language,      // e.g., "TypeScript", "Python", "YAML"
    changeType: profile.type,        // "logic" | "config" | "dependency"
    defaultAreas: profile.areas,     // Default review concerns for this language
    addedLines: [],                  // Will be filled as we parse "+" lines
    contextLines: []                 // Will be filled as we parse " " (space) lines
  };
}

/**
 * Parses a complete unified diff string into an array of ParsedDiffFile objects.
 *
 * Handles:
 *   - Multiple files in one diff (multiple `diff --git` headers)
 *   - Multiple hunks per file (multiple `@@` headers)
 *   - Windows (CRLF) and Unix (LF) line endings
 *   - `\ No newline at end of file` markers (skipped, don't increment line counter)
 *   - Language detection from both the initial `diff --git` path and `+++ b/` path
 *
 * @param diffText - Raw unified diff string from git
 * @returns Array of parsed file objects, one per changed file
 */
export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  // Split the diff into individual lines, handling both CRLF and LF
  const lines = diffText.split(/\r?\n/);
  const files: ParsedDiffFile[] = []; // Accumulates completed file objects
  let current: ParsedDiffFile | null = null; // The file we're currently parsing
  let nextLineNumber = 0; // Tracks the current line number in the new file version

  for (const line of lines) {
    // ── New file boundary ──────────────────────────────────────────────────────
    // `diff --git a/src/foo.ts b/src/foo.ts` signals the start of a new file.
    // Save the previous file (if any) and start a fresh one.
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current); // Save completed file before starting next

      // Extract the `b/` path from the diff header as initial file path guess.
      // This gets overwritten when we see the more reliable `+++ b/` line below.
      const match = line.match(/ b\/(.+)$/);
      current = createEmptyFile(match ? match[1] : "unknown");
      nextLineNumber = 0; // Reset line counter for the new file
      continue;
    }

    // Skip lines before the first file header
    if (!current) continue;

    // ── Hunk header ────────────────────────────────────────────────────────────
    // `@@ -10,6 +10,8 @@` tells us where in the new file this hunk starts.
    // Parse the `+N` part to know what line number to assign to the next line.
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/); // Extract starting line number
      nextLineNumber = match ? Number(match[1]) : 0;
      continue;
    }

    // ── Authoritative file path ────────────────────────────────────────────────
    // `+++ b/src/foo.ts` is the most reliable source of the final file path.
    // Override the path from the `diff --git` header and re-detect language.
    if (line.startsWith("+++ b/")) {
      current.file = line.replace("+++ b/", "").trim(); // Strip "+++ b/" prefix
      const profile = detectLanguage(current.file);     // Re-detect from final path
      current.language = profile.language;
      current.changeType = profile.type;
      current.defaultAreas = profile.areas;
      continue;
    }

    // ── Added line ────────────────────────────────────────────────────────────
    // Lines starting with "+" (but not "+++" which is the file header) are new code.
    // These are what we focus review on — the actual changes in this PR.
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push({
        line: nextLineNumber,
        content: line.slice(1) // Remove the leading "+" to get the raw code
      });
      nextLineNumber += 1; // Advance line counter (added lines exist in the new file)
      continue;
    }

    // ── Removed line ──────────────────────────────────────────────────────────
    // Lines starting with "-" are deleted code — we skip these entirely.
    // Removed lines don't exist in the new file so they don't get a line number.
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue; // Skip removed lines — they're gone from the file
    }

    // ── Context line ──────────────────────────────────────────────────────────
    // Unchanged lines (prefixed with " ") provide surrounding context.
    // We keep these so AI agents can see what's around the changed code.
    // Also handles bare lines (no prefix) that may appear in some diff formats.
    current.contextLines.push({
      line: nextLineNumber,
      content: line.startsWith(" ") ? line.slice(1) : line // Remove leading space if present
    });

    // `\ No newline at end of file` marker — don't advance line counter for this
    if (!line.startsWith("\\")) nextLineNumber += 1;
  }

  // Push the last file in the diff (loop ends without a final `diff --git` trigger)
  if (current) files.push(current);

  return files;
}
