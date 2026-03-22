#!/usr/bin/env node
import "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readDiffFromFile, readStdin } from "./utils/fs.js";
import { buildGithubPRReviewReport, initProject, reviewDiff } from "./index.js";
import type { InstallProviderChoice, ReviewResult } from "./types.js";
import { loadProjectEnv } from "./utils/env.js";

const TOOL_DIR = "pr-review-orchestrator";
const LOCAL_CONFIG_PATH = `${TOOL_DIR}/local.json`;
const PROJECT_CONFIG_PATH = `${TOOL_DIR}/config.json`;

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getCommand(): string {
  const firstArg = process.argv[2];
  if (!firstArg || firstArg.startsWith("-")) return "review";
  return firstArg;
}

function isInteractiveShell(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function getDefaultModel(providerChoice: InstallProviderChoice): string {
  switch (providerChoice) {
    case "anthropic":
      return "claude-opus-4-6";
    case "openai":
      return "gpt-4o-mini";
    case "gemini":
      return "gemini-2.0-flash";
    case "ollama":
      return "llama3.2";
    case "local":
      return "local-rules-only";
    case "groq":
    default:
      return "llama-3.3-70b-versatile";
  }
}

function getRequiredKey(providerChoice: InstallProviderChoice): string {
  switch (providerChoice) {
    case "groq":
      return "GROQ_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "ollama":
      return "OLLAMA_HOST";
    default:
      return "none";
  }
}

async function promptInitSelection(): Promise<{ providerChoice: InstallProviderChoice; model: string }> {
  const rl = createInterface({ input, output });

  try {
    console.log(`
Choose how this repo should run PR reviews:
  1. Groq free multi-agent
  2. Gemini free multi-agent
  3. Ollama local multi-agent
  4. Anthropic Claude paid multi-agent
  5. OpenAI paid mode
  6. Local rules only
`);

    const providerAnswer = (await rl.question("Select provider [1]: ")).trim() || "1";
    const providerChoice =
      ({
        "1": "groq",
        "2": "gemini",
        "3": "ollama",
        "4": "anthropic",
        "5": "openai",
        "6": "local"
      } as Record<string, InstallProviderChoice>)[providerAnswer] ?? "groq";

    const defaultModel = getDefaultModel(providerChoice);
    const model = (await rl.question(`Model [${defaultModel}]: `)).trim() || defaultModel;

    return { providerChoice, model };
  } finally {
    rl.close();
  }
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
          },
          reports: {
            pr_comments: [],
            agent_runs: [],
            findings: [],
            files: [],
            markdown_summary: "# PR Review Summary\n\nNo changed files were reviewed."
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
  const providerArg = getArg("--provider") as InstallProviderChoice | undefined;
  const modelArg = getArg("--model");
  const selection = providerArg
    ? { providerChoice: providerArg, model: modelArg || getDefaultModel(providerArg) }
    : isInteractiveShell()
      ? await promptInitSelection()
      : { providerChoice: "groq" as InstallProviderChoice, model: getDefaultModel("groq") };

  const result = await initProject({
    ci,
    targetDir,
    installSource,
    providerChoice: selection.providerChoice,
    model: selection.model
  });
  const repoName = result.rootDir.split(/[\\/]/).pop() ?? "your-repo";
  const requiredKey = getRequiredKey(selection.providerChoice);

  const writtenList = result.writtenFiles.map((f) => `  + ${f.replace(result.rootDir, "")}`).join("\n");
  const updatedList = result.updatedFiles.map((f) => `  ~ ${f.replace(result.rootDir, "")}`).join("\n");
  const skippedList = result.skippedFiles.length
    ? result.skippedFiles.map((f) => `  - skipped (exists): ${f.replace(result.rootDir, "")}`).join("\n")
    : "";

  console.log(`
PR Review Orchestrator - Setup complete

Files created in: ${result.rootDir}
${[writtenList, updatedList, skippedList].filter(Boolean).join("\n")}

Detected repo type: ${result.detectedRepoTypes.join(", ")}
Agents: security | bug | logic | types | eslint | performance | best-practices | quality
Selected provider profile: ${selection.providerChoice}
Selected model: ${selection.model}

---------------------------------------------------------
 SINGLE TOOL FOLDER
---------------------------------------------------------
 All tool files now live in:
   ${TOOL_DIR}/

 Developer secret and model file:
   ${LOCAL_CONFIG_PATH}

 Developer project config file:
   ${PROJECT_CONFIG_PATH}

---------------------------------------------------------
 NEXT STEPS
---------------------------------------------------------

1. Open ${LOCAL_CONFIG_PATH} and add your API key and model:

   Required setting: ${requiredKey}
   Selected model: ${selection.model}

2. Add the same value as a GitHub repository secret for CI:
   https://github.com/YOUR-USERNAME/${repoName}/settings/secrets/actions
   Name: ${requiredKey}

3. Commit and push the non-secret files:
   git add .github/workflows/pr-review-orchestrator.yml \\
           ${PROJECT_CONFIG_PATH} \\
           .gitignore
   git commit -m "add AI PR review"
   git push

4. Open or update any PR. The workflow will review changed files
   and post file-level findings in GitHub PR comments.
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

