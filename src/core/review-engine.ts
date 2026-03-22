import { parseUnifiedDiff } from "./diff-parser.js";
import { buildPromptPayload } from "./prompt-builder.js";
import { createEmptyReview, finalizeSummary } from "./schema.js";
import { triageFile } from "./triage.js";
import { createProvider } from "../providers/index.js";
import type { DryRunResult, ReviewOptions, ReviewResult, TriagedFile } from "../types.js";
import { loadProjectEnv } from "../utils/env.js";
import { readWorkingTreeFileLines } from "../utils/fs.js";

export async function reviewDiff(diffText: string, options: ReviewOptions = {}): Promise<ReviewResult | DryRunResult> {
  await loadProjectEnv();

  const parsedFiles = parseUnifiedDiff(diffText);
  const enrichedFiles = await Promise.all(
    parsedFiles.map(async (file) => ({
      ...file,
      fullFileLines: await readWorkingTreeFileLines(file.file)
    }))
  );
  const triaged: TriagedFile[] = enrichedFiles.map((file) => ({
    ...file,
    triage: triageFile(file)
  }));

  if (options.dryRun) {
    return {
      parsed_files: triaged,
      prompt_payload: buildPromptPayload(triaged)
    };
  }

  const provider = createProvider(options.provider);
  if (!provider) {
    const empty = createEmptyReview(triaged);
    empty.files.forEach((file, index) => {
      file.triage = triaged[index].triage;
    });
    return finalizeSummary(empty);
  }

  const promptPayload = buildPromptPayload(triaged);
  const result = await provider.review(promptPayload, triaged);

  if (!result || !Array.isArray(result.files)) {
    const empty = createEmptyReview(triaged);
    empty.files.forEach((file, index) => {
      file.triage = triaged[index].triage;
    });
    return finalizeSummary(empty);
  }

  result.files = triaged.map((file, index) => ({
    ...(result.files[index] ?? createEmptyReview([file]).files[0]),
    file: file.file,
    language: file.language,
    triage: result.files[index]?.triage ?? file.triage
  }));

  return finalizeSummary(result);
}

