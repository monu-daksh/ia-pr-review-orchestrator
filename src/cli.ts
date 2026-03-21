#!/usr/bin/env node
import "node:process";
import { readDiffFromFile, readStdin } from "./utils/fs.js";
import { buildGithubPRReviewReport, initProject, reviewDiff } from "./index.js";
import type { ReviewResult } from "./types.js";
import { loadProjectEnv } from "./utils/env.js";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getCommand(): string {
  const firstArg = process.argv[2];
  if (!firstArg || firstArg.startsWith("-")) return "review";
  return firstArg;
}

async function runReview(): Promise<void> {
  await loadProjectEnv();

  const diffFile = getArg("--diff");
  const useStdin = process.argv.includes("--stdin");
  const dryRun = process.argv.includes("--dry-run");
  const provider = getArg("--provider");
  const format = getArg("--format") || "json";

  let diffText = "";
  if (diffFile) diffText = await readDiffFromFile(diffFile);
  if (useStdin) diffText = await readStdin();

  if (!diffText.trim()) {
    console.log(
      JSON.stringify(
        {
          files: [],
          summary: {
            total_files: 0,
            total_issues: 0,
            critical_count: 0,
            high_count: 0,
            medium_count: 0,
            low_count: 0,
            final_decision: "approve"
          }
        },
        null,
        2
      )
    );
    return;
  }

  const result = await reviewDiff(diffText, { dryRun, provider });
  if (format === "github-pr" && !("parsed_files" in result)) {
    console.log(JSON.stringify(buildGithubPRReviewReport(result as ReviewResult), null, 2));
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

async function runInit(): Promise<void> {
  const ci = (getArg("--ci") || "github") as "github" | "gitlab" | "both" | "none";
  const targetDir = getArg("--cwd");
  const installSource = getArg("--install-source") ?? "latest";

  const result = await initProject({ ci, targetDir, installSource });
  const repoName = result.rootDir.split(/[\\/]/).pop() ?? "your-repo";

  const writtenList = result.writtenFiles.map((f) => `  + ${f.replace(result.rootDir, "")}`).join("\n");
  const updatedList = result.updatedFiles.map((f) => `  ~ ${f.replace(result.rootDir, "")}`).join("\n");
  const skippedList = result.skippedFiles.length
    ? result.skippedFiles.map((f) => `  - skipped (exists): ${f.replace(result.rootDir, "")}`).join("\n")
    : "";

  console.log(`
PR Review Orchestrator — Setup complete

Files created in: ${result.rootDir}
${[writtenList, updatedList, skippedList].filter(Boolean).join("\n")}

Detected repo type: ${result.detectedRepoTypes.join(", ")}
Agents: security · bug · logic · types · eslint · quality (6 run in parallel per file)

─────────────────────────────────────────────────────────
 NEXT STEPS
─────────────────────────────────────────────────────────

1. Open .pr-review-orchestrator and add your API key:

   GROQ_API_KEY=your_groq_api_key_here   ← FREE  https://console.groq.com
   # or when ready to upgrade:
   # ANTHROPIC_API_KEY=your_key_here     ← PAID  https://console.anthropic.com

   This file is already gitignored — your key stays private.

2. Add the same key as a GitHub repository secret (for CI):
   https://github.com/YOUR-USERNAME/${repoName}/settings/secrets/actions
   Name: GROQ_API_KEY

3. Commit and push the non-secret files:
   git add .github/workflows/pr-review-orchestrator.yml \\
           pr-review-orchestrator.config.json \\
           .gitignore
   git commit -m "add AI PR review"
   git push

4. Open any PR (or push a new file) — the 6 agents run automatically
   and post inline review comments on the PR.

─────────────────────────────────────────────────────────
 UPGRADING TO ANTHROPIC CLAUDE LATER
─────────────────────────────────────────────────────────
 No library code changes needed. Just:
   1. Edit .pr-review-orchestrator — uncomment ANTHROPIC_API_KEY
   2. Add ANTHROPIC_API_KEY to GitHub Secrets
   All 6 agents switch to claude-opus-4-6 automatically.
─────────────────────────────────────────────────────────
`);
}

async function main() {
  const command = getCommand();

  if (command === "init") {
    await runInit();
    return;
  }

  await runReview();
}

main().catch(() => {
  process.exitCode = 1;
});
