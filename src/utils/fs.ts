import fs from "node:fs/promises";
import type { ContextLine } from "../types.js";

export async function readDiffFromFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readWorkingTreeFileLines(filePath: string): Promise<ContextLine[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split(/\r?\n/).map((line, index) => ({
      line: index + 1,
      content: line
    }));
  } catch {
    return [];
  }
}

