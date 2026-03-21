import fs from "node:fs/promises";

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

