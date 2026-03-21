import { detectLanguage } from "../config/language-profiles.js";
import type { ParsedDiffFile } from "../types.js";

function createEmptyFile(filePath: string): ParsedDiffFile {
  const profile = detectLanguage(filePath);
  return {
    file: filePath,
    language: profile.language,
    changeType: profile.type,
    defaultAreas: profile.areas,
    addedLines: [],
    contextLines: []
  };
}

export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  const lines = diffText.split(/\r?\n/);
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let nextLineNumber = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = line.match(/ b\/(.+)$/);
      current = createEmptyFile(match ? match[1] : "unknown");
      nextLineNumber = 0;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      nextLineNumber = match ? Number(match[1]) : 0;
      continue;
    }

    if (line.startsWith("+++ b/")) {
      current.file = line.replace("+++ b/", "").trim();
      const profile = detectLanguage(current.file);
      current.language = profile.language;
      current.changeType = profile.type;
      current.defaultAreas = profile.areas;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push({
        line: nextLineNumber,
        content: line.slice(1)
      });
      nextLineNumber += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    current.contextLines.push({
      line: nextLineNumber,
      content: line.startsWith(" ") ? line.slice(1) : line
    });
    if (!line.startsWith("\\")) nextLineNumber += 1;
  }

  if (current) files.push(current);
  return files;
}

