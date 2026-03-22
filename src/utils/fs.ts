/**
 * ============================================================
 * FILE: src/utils/fs.ts
 * PURPOSE: File I/O utilities for reading diffs and working tree files.
 *
 * FUNCTIONS:
 *   readDiffFromFile()        — Read a unified diff from a file on disk
 *   readStdin()               — Read a unified diff piped via stdin
 *   readWorkingTreeFileLines()— Read the current full content of a file
 *                               from disk (used to enrich diff with full context)
 *
 * WHY readWorkingTreeFileLines?
 *   The diff only contains changed lines + a few context lines.
 *   AI agents can detect more issues when they can see the ENTIRE file.
 *   For example, a security agent can find a hardcoded secret on line 1
 *   even if the changed lines are on lines 50-60.
 *   This function reads the file at its current disk path and returns
 *   all lines with line numbers, so agents can review pre-existing issues.
 * ============================================================
 */

import fs from "node:fs/promises";
import type { ContextLine } from "../types.js";

/**
 * Reads a unified diff from a file on disk.
 * Used when the CLI receives a --diff <path> argument.
 *
 * @param filePath - Absolute or relative path to the diff file
 * @returns The raw diff string
 * @throws If the file doesn't exist or can't be read
 */
export async function readDiffFromFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

/**
 * Reads a unified diff from stdin (standard input).
 * Used when the CLI receives input via pipe: `git diff | pr-review-orchestrator review`
 *
 * Collects all chunks from the stdin stream and concatenates them.
 * Returns an empty string if stdin is empty (no pipe).
 *
 * @returns The complete stdin content as a string
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  // Iterate over async chunks from stdin
  for await (const chunk of process.stdin) {
    // Ensure each chunk is a Buffer (stream may yield Buffer or string)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // Concatenate all chunks and decode as UTF-8 text
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads the full current content of a file from the working tree (disk).
 * Returns each line as a ContextLine with its 1-based line number.
 *
 * This is used by review-engine.ts to "enrich" each parsed diff file
 * with the complete file content, so AI agents can:
 *   - Review pre-existing issues not in the diff
 *   - Understand the full context around changed code
 *   - Catch hardcoded secrets, XSS patterns, etc. anywhere in the file
 *
 * Returns an empty array (silently) if:
 *   - The file doesn't exist (deleted file, new file not yet on disk)
 *   - Permission denied
 *   - Any other read error
 *
 * @param filePath - Relative path from the working directory (e.g., "src/api/user.ts")
 * @returns Array of ContextLine objects, one per line in the file, or [] on error
 */
export async function readWorkingTreeFileLines(filePath: string): Promise<ContextLine[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    // Split on both CRLF (Windows) and LF (Unix) line endings
    return content.split(/\r?\n/).map((line, index) => ({
      line: index + 1, // 1-based line numbers (matching diff format and editor display)
      content: line    // The actual code on this line
    }));
  } catch {
    // File not readable — return empty array so the review continues without full context
    // The agent will fall back to using only the diff's added/context lines
    return [];
  }
}
