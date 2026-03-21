import { REVIEW_INSTRUCTIONS, SYSTEM_PROMPT } from "../config/review-rules.js";
import type { PromptPayload, TriagedFile } from "../types.js";

export function buildPromptPayload(files: TriagedFile[]): PromptPayload {
  const normalizedFiles = files.map((file) => ({
    file: file.file,
    language: file.language,
    change_type: file.changeType,
    added_lines: file.addedLines,
    context_preview: file.contextLines.slice(-12)
  }));

  return {
    system: SYSTEM_PROMPT,
    user: {
      instructions: REVIEW_INSTRUCTIONS,
      files: normalizedFiles
    }
  };
}

