#!/usr/bin/env node
/**
 * ============================================================
 * FILE: src/cli.ts
 * PURPOSE: Command-line interface entry point.
 *          This is what runs when you call `pr-review-orchestrator` in your terminal
 *          or in a GitHub Actions workflow step.
 *
 * COMMANDS:
 *   pr-review-orchestrator init    — Interactive setup wizard. Prompts for provider,
 *                                    generates config files and CI workflow templates.
 *
 *   pr-review-orchestrator review  — Reviews a diff. This is the default command
 *   (or no command)                  (runs when no command name is specified).
 *
 * REVIEW FLAGS:
 *   --diff <path>    — Read the diff from a file (e.g., --diff changes.diff)
 *   --stdin          — Read the diff from stdin (e.g., git diff | pr-review-orchestrator)
 *   --dry-run        — Parse and triage only — skip AI, return prompt payload
 *   --provider <name>— Override the auto-detected provider (multi-agent|claude|groq|etc.)
 *   --format <name>  — Output format: "json" (default) or "github-pr" (GitHub PR comments)
 *
 * INIT FLAGS:
 *   --provider <name>— Skip the interactive prompt, set provider directly
 *   --model <name>   — Set the model name directly
 *   --ci <target>    — CI template to generate: github|gitlab|both|none (default: github)
 *   --cwd <path>     — Target directory for generated files (default: process.cwd())
 *   --install-source — Override the install source in the generated workflow
 *
 * EXAMPLES:
 *   git diff HEAD~1 | pr-review-orchestrator --stdin
 *   pr-review-orchestrator --diff changes.diff --format github-pr
 *   pr-review-orchestrator init --provider groq
 *   pr-review-orchestrator init --provider anthropic --ci both
 *
 * OUTPUT:
 *   Always prints JSON to stdout. The caller (CI step, script) parses this output.
 *   Errors cause process.exitCode = 1 but output is still valid JSON when possible.
 * ============================================================
 */

import "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readDiffFromFile, readStdin } from "./utils/fs.js";
import { buildGithubPRReviewReport, initProject, reviewDiff } from "./index.js";
import type { InstallProviderChoice, ReviewResult } from "./types.js";
import { loadProjectEnv } from "./utils/env.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Directory where pr-review-orchestrator stores its config files */
const TOOL_DIR = "pr-review-orchestrator";

/** Path to the main config file created by `init` */
const INIT_CONFIG_PATH = `${TOOL_DIR}/init.json`;

// ─── CLI Argument Helpers ─────────────────────────────────────────────────────

/**
 * Returns the value of a named CLI flag.
 * Example: getArg("--diff") on `--diff changes.diff` returns "changes.diff"
 *
 * @param flag - The flag name to look for (e.g., "--diff")
 * @returns The value after the flag, or undefined if the flag isn't present
 */
function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Returns the CLI command name from the first non-flag argument.
 * If the first argument starts with "-" or doesn't exist, defaults to "review".
 *
 * Examples:
 *   `pr-review-orchestrator init`   → "init"
 *   `pr-review-orchestrator review` → "review"
 *   `pr-review-orchestrator --diff` → "review" (starts with -, so default)
 *   `pr-review-orchestrator`        → "review" (no argument, so default)
 */
function getCommand(): string {
  const firstArg = process.argv[2];
  if (!firstArg || firstArg.startsWith("-")) return "review"; // Default command
  return firstArg;
}

/**
 * Returns true if running in an interactive terminal where prompts can be shown.
 * Used to decide whether to show the interactive init prompt or use defaults.
 * Returns false in CI environments (where stdin/stdout are not TTYs).
 */
function isInteractiveShell(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// ─── Provider/Model Defaults ──────────────────────────────────────────────────

/**
 * Returns the recommended default model name for a given provider choice.
 * Shown in the interactive init prompt as the default value.
 *
 * @param providerChoice - The selected provider
 * @returns Default model name string
 */
function getDefaultModel(providerChoice: InstallProviderChoice): string {
  switch (providerChoice) {
    case "anthropic":
      return "claude-opus-4-6";         // Highest quality Claude model
    case "openai":
      return "gpt-4o-mini";             // Fast, cheap OpenAI model
    case "gemini":
      return "gemini-2.0-flash";        // Fast, free-tier Gemini model
    case "ollama":
      return "llama3.2";                // Popular local Ollama model
    case "local":
      return "local-rules-only";        // No model needed for local pattern agents
    case "groq":
    default:
      return "llama-3.3-70b-versatile"; // Best free Groq model
  }
}

/**
 * Returns the environment variable name that holds the API key for a provider.
 * Used in the init post-setup instructions to tell users which secret to add to GitHub.
 *
 * @param providerChoice - The selected provider
 * @returns The env var name (e.g., "GROQ_API_KEY") or "none" for providers without a key
 */
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
      return "OLLAMA_HOST";             // Ollama uses a host URL, not a key
    default:
      return "none";                    // "local" provider needs no credential
  }
}

// ─── Interactive Init Prompt ──────────────────────────────────────────────────

/**
 * Shows the interactive provider selection prompt for `pr-review-orchestrator init`.
 * Only runs in interactive terminals (not CI or piped input).
 *
 * @returns The selected provider choice and model name
 */
async function promptInitSelection(): Promise<{ providerChoice: InstallProviderChoice; model: string }> {
  const rl = createInterface({ input, output });

  try {
    // Show the menu of available providers
    console.log(`
Choose how this repo should run PR reviews:
  1. Groq free multi-agent
  2. Gemini free multi-agent
  3. Ollama local multi-agent
  4. Anthropic Claude paid multi-agent
  5. OpenAI paid mode
  6. Local rules only
`);

    // Read provider selection (default: 1 = Groq)
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

    // Read model name (default: provider's recommended model)
    const defaultModel = getDefaultModel(providerChoice);
    const model = (await rl.question(`Model [${defaultModel}]: `)).trim() || defaultModel;

    return { providerChoice, model };
  } finally {
    rl.close(); // Always close readline interface to avoid hanging
  }
}

// ─── Review Command ───────────────────────────────────────────────────────────

/**
 * Runs the `review` command — the main PR review workflow.
 *
 * Flow:
 *   1. Load env files (API keys)
 *   2. Read diff from file or stdin
 *   3. If no diff provided → output empty approve result
 *   4. Run reviewDiff() with the diff text
 *   5. Output JSON result (or GitHub PR format if --format github-pr)
 */
async function runReview(): Promise<void> {
  await loadProjectEnv(); // Load API keys from .env files and init.json

  // Read CLI flags
  const diffFile = getArg("--diff");                        // Path to diff file
  const useStdin = process.argv.includes("--stdin");        // Read diff from stdin pipe
  const dryRun = process.argv.includes("--dry-run");        // Skip AI, return parsed data only
  const provider = getArg("--provider");                    // Override provider selection
  const format = getArg("--format") || "json";              // Output format: "json" or "github-pr"

  // Read the diff text from the specified source
  let diffText = "";
  if (diffFile) diffText = await readDiffFromFile(diffFile); // Read from file path
  if (useStdin) diffText = await readStdin();                 // Read from stdin pipe

  // If no diff was provided (or it's empty), output a clean empty approve result
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
            final_decision: "approve" // No diff = approve
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
        2 // Pretty-print with 2-space indent
      )
    );
    return;
  }

  // Run the review (this calls the full AI/local agent pipeline)
  const result = await reviewDiff(diffText, { dryRun, provider });

  // If GitHub PR format requested and result is a full ReviewResult (not dry-run)
  if (format === "github-pr" && !("parsed_files" in result)) {
    // Convert to GitHub PR comment format and output
    console.log(JSON.stringify(buildGithubPRReviewReport(result as ReviewResult), null, 2));
    return;
  }

  // Default: output the raw ReviewResult (or DryRunResult) as JSON
  console.log(JSON.stringify(result, null, 2));
}

// ─── Init Command ─────────────────────────────────────────────────────────────

/**
 * Runs the `init` command — sets up pr-review-orchestrator in a project.
 *
 * Flow:
 *   1. Read flags (provider, model, ci target, directory)
 *   2. If no provider flag: show interactive prompt (TTY) or use defaults (CI)
 *   3. Run initProject() to generate config files and CI templates
 *   4. Print next steps instructions
 *
 * Generated files:
 *   pr-review-orchestrator/init.json           — Main config with provider + API key placeholder
 *   .env.example                               — Template for credentials
 *   .github/workflows/pr-review-orchestrator.yml — GitHub Actions workflow
 *   pr-review-orchestrator.gitlab-ci.yml       — GitLab CI template (if --ci gitlab or both)
 */
async function runInit(): Promise<void> {
  // Read init-specific flags
  const ci = (getArg("--ci") || "github") as "github" | "gitlab" | "both" | "none"; // CI target
  const targetDir = getArg("--cwd");              // Where to write config files
  const installSource = getArg("--install-source"); // Override install source in workflow
  const providerArg = getArg("--provider") as InstallProviderChoice | undefined;
  const modelArg = getArg("--model");

  // Determine provider and model selection:
  //   1. Use --provider flag if provided (non-interactive, good for CI-based init)
  //   2. Show interactive prompt if in a terminal
  //   3. Fall back to Groq defaults if not interactive (CI auto-init)
  const selection = providerArg
    ? { providerChoice: providerArg, model: modelArg || getDefaultModel(providerArg) }
    : isInteractiveShell()
      ? await promptInitSelection()         // Interactive terminal: show menu
      : { providerChoice: "groq" as InstallProviderChoice, model: getDefaultModel("groq") }; // CI: use Groq default

  // Run the setup wizard to generate config files and CI templates
  const result = await initProject({
    ci,
    targetDir,
    installSource,
    providerChoice: selection.providerChoice,
    model: selection.model
  });

  // Extract repo name from the target directory path for display
  const repoName = result.rootDir.split(/[\\/]/).pop() ?? "your-repo";
  const requiredKey = getRequiredKey(selection.providerChoice); // Which env var key to show

  // Build lists of file operations for the summary output
  const writtenList = result.writtenFiles.map((f) => `  + ${f.replace(result.rootDir, "")}`).join("\n");
  const updatedList = result.updatedFiles.map((f) => `  ~ ${f.replace(result.rootDir, "")}`).join("\n");
  const skippedList = result.skippedFiles.length
    ? result.skippedFiles.map((f) => `  - skipped (exists): ${f.replace(result.rootDir, "")}`).join("\n")
    : "";

  // Print the setup summary and next steps instructions
  console.log(`
PR Review Orchestrator - Setup complete

Files created in: ${result.rootDir}
${[writtenList, updatedList, skippedList].filter(Boolean).join("\n")}

Selected provider profile: ${selection.providerChoice}
Selected model: ${selection.model}

---------------------------------------------------------
 SIMPLE TOOL FOLDER
---------------------------------------------------------
 The tool creates only one config file for developers:
   ${INIT_CONFIG_PATH}

 Developers edit that file and put:
   - API key
   - model name
   - provider choice

---------------------------------------------------------
 NEXT STEPS
---------------------------------------------------------

1. Open ${INIT_CONFIG_PATH} and add your API key and model:

   Required setting: ${requiredKey}
   Selected model: ${selection.model}

2. Add the same key to GitHub repository secrets for CI:
   https://github.com/YOUR-USERNAME/${repoName}/settings/secrets/actions
   Name: ${requiredKey}

3. Commit and push the non-secret files:
   git add .github/workflows/pr-review-orchestrator.yml .gitignore
   git commit -m "add AI PR review"
   git push

4. Open or update any PR. The workflow will review changed files,
   run all agents, and post findings in GitHub PR comments.
`);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Main entry point — reads the command and routes to init or review.
 */
async function main() {
  const command = getCommand();

  if (command === "init") {
    await runInit(); // Setup wizard
    return;
  }

  await runReview(); // Default: run a PR review
}

// Start the CLI — if anything throws, set exit code 1 (failure)
main().catch(() => {
  process.exitCode = 1;
});
