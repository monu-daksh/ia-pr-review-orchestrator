import fs from "node:fs/promises";
import path from "node:path";

interface InitOptions {
  targetDir?: string;
  ci?: "github" | "gitlab" | "both" | "none";
  installSource?: string;
}

interface InitResult {
  rootDir: string;
  detectedRepoTypes: string[];
  writtenFiles: string[];
  updatedFiles: string[];
  skippedFiles: string[];
}

function detectRepoTypes(fileNames: Set<string>): string[] {
  const types = new Set<string>();

  if (fileNames.has("package.json")) types.add("node");
  if (fileNames.has("package.json") && (fileNames.has("tsconfig.json") || fileNames.has("vite.config.ts") || fileNames.has("next.config.js"))) {
    types.add("react");
  }
  if (fileNames.has("pyproject.toml") || fileNames.has("requirements.txt")) types.add("python");
  if (fileNames.has("pom.xml") || fileNames.has("build.gradle") || fileNames.has("build.gradle.kts")) types.add("java");

  return types.size > 0 ? [...types] : ["generic"];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeFileIfMissing(filePath: string, content: string, result: InitResult): Promise<void> {
  if (await pathExists(filePath)) {
    result.skippedFiles.push(filePath);
    return;
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  result.writtenFiles.push(filePath);
}

/**
 * Builds the AI keys + model config file that lives in the working repo.
 *
 * This file is GITIGNORED — it holds the actual API key.
 * The library loads it automatically via loadProjectEnv().
 * Developers just fill in their key and model, then everything works.
 */
function buildAiConfig(): string {
  return [
    "# ─────────────────────────────────────────────────────────────────────────",
    "# pr-review-orchestrator — AI keys & model config",
    "#",
    "# !! GITIGNORED — never commit this file, it contains your API key !!",
    "#",
    "# This file is read automatically by the library.",
    "# Fill in ONE provider key below, save, and the review agents are ready.",
    "# ─────────────────────────────────────────────────────────────────────────",
    "",
    "# ── STEP 1: Choose a provider ────────────────────────────────────────────",
    "# multi-agent = 6 specialized agents (security, bug, logic, types, eslint, quality)",
    "# The agents automatically use whichever key you provide below.",
    "PR_REVIEW_PROVIDER=multi-agent",
    "",
    "# ── STEP 2: Add your API key (fill in one block, comment out the rest) ───",
    "",
    "# ┌─ FREE — Groq + Llama 3.3 70B (recommended to start) ───────────────────",
    "# │  14,400 requests/day · very fast · get free key: https://console.groq.com",
    "GROQ_API_KEY=your_groq_api_key_here",
    "GROQ_MODEL=llama-3.3-70b-versatile",
    "",
    "# ┌─ FREE — Google Gemini Flash (alternative free option) ─────────────────",
    "# │  1M tokens/day · get free key: https://aistudio.google.com/apikey",
    "# GEMINI_API_KEY=your_gemini_api_key_here",
    "# GEMINI_MODEL=gemini-2.0-flash",
    "",
    "# ┌─ FREE — Ollama (local, offline, no API key needed) ────────────────────",
    "# │  Install: https://ollama.com  then run: ollama pull llama3.2",
    "# OLLAMA_HOST=http://localhost:11434",
    "# OLLAMA_MODEL=llama3.2",
    "",
    "# ┌─ PAID — Anthropic Claude (best quality, upgrade when ready) ────────────",
    "# │  When you add this key, all 6 agents auto-upgrade to Claude.",
    "# │  No code changes needed. Get key: https://console.anthropic.com",
    "# ANTHROPIC_API_KEY=your_anthropic_api_key_here",
    "# ANTHROPIC_MODEL=claude-opus-4-6      # best quality",
    "# ANTHROPIC_MODEL=claude-sonnet-4-6    # balanced speed/quality",
    "# ANTHROPIC_MODEL=claude-haiku-4-5     # fastest / cheapest",
    "",
    "# ┌─ PAID — OpenAI (alternative paid option) ───────────────────────────────",
    "# OPENAI_API_KEY=your_openai_api_key_here",
    "# OPENAI_MODEL=gpt-4o-mini",
    ""
  ].join("\n");
}

/**
 * Builds pr-review-orchestrator.config.json — committed to git, no secrets.
 * Controls which paths to review, CI severity thresholds, etc.
 */
function buildConfig(repoTypes: string[]): string {
  const include = repoTypes.includes("react")
    ? ["src", "app", "components", "pages", "server", "api"]
    : repoTypes.includes("python")
      ? ["src", "app", "services", "tests"]
      : repoTypes.includes("java")
        ? ["src/main", "src/test"]
        : ["src", "server", "api"];

  return JSON.stringify(
    {
      provider: "multi-agent",
      ci: {
        failOnSeverity: []
      },
      review: {
        includePaths: include,
        maxContextLines: 12
      },
      repo: {
        detectedTypes: repoTypes
      }
    },
    null,
    2
  );
}

function buildGithubWorkflow(): string {
  return `name: PR Review Orchestrator

on:
  # Fires when a PR is opened, new commits are pushed to it, or new files are added
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main, master, develop]

  # Also fires on direct push to main (e.g. a merge commit)
  push:
    branches: [main, master]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Run AI review
        env:
          # ── API keys — add these in GitHub: Settings → Secrets → Actions ────
          # Only ONE key is needed. The agents auto-pick whichever is available.
          #
          # FREE  → GROQ_API_KEY   (Groq, Llama 3.3 70B) https://console.groq.com
          # FREE  → GEMINI_API_KEY (Gemini Flash)         https://aistudio.google.com/apikey
          # PAID  → ANTHROPIC_API_KEY (Claude, upgrade)   https://console.anthropic.com
          GROQ_API_KEY: \${{ secrets.GROQ_API_KEY }}
          GROQ_MODEL: \${{ secrets.GROQ_MODEL }}
          GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          ANTHROPIC_MODEL: \${{ secrets.ANTHROPIC_MODEL }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          # ── Provider + model — read from pr-review-orchestrator.config.json ──
          # Override here only if you need a different value in CI:
          # PR_REVIEW_PROVIDER: groq
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
        run: |
          if [ "\${{ github.event_name }}" = "pull_request" ]; then
            git diff origin/\${{ github.base_ref }}...HEAD > pr.diff
          else
            git diff HEAD~1...HEAD > pr.diff
          fi
          npx pr-review-orchestrator review --diff ./pr.diff --format github-pr > review.json

      - name: Post PR Review Comments
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const review = JSON.parse(fs.readFileSync('review.json', 'utf8'));
            const comments = Array.isArray(review.comments) ? review.comments : [];

            if (comments.length > 0) {
              await github.rest.pulls.createReview({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: context.payload.pull_request.number,
                commit_id: context.payload.pull_request.head.sha,
                event: 'COMMENT',
                comments: comments.map((c) => ({
                  path: c.path,
                  line: c.line,
                  side: 'RIGHT',
                  body: c.body
                }))
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.payload.pull_request.number,
                body: 'PR Review Orchestrator: no high-confidence findings in this diff.'
              });
            }

      # Uncomment to block the pipeline on critical/high findings:
      # - name: Block on critical findings
      #   run: |
      #     node -e "const r=JSON.parse(require('fs').readFileSync('review.json','utf8')); if((r.summary?.critical_count??0)>0||(r.summary?.high_count??0)>0)process.exit(1);"

      - name: Upload review artifact
        uses: actions/upload-artifact@v4
        with:
          name: pr-review-json
          path: review.json
`;
}

function buildGitlabCi(): string {
  return `stages:
  - review

pr_review:
  image: node:20
  stage: review
  only:
    - merge_requests
    - main
    - master
  variables:
    # ── API keys — add these in GitLab: Settings → CI/CD → Variables ─────────
    # Only ONE key is needed. Agents auto-pick whichever is available.
    #
    # FREE  → GROQ_API_KEY   (Groq, Llama 3.3 70B) https://console.groq.com
    # FREE  → GEMINI_API_KEY (Gemini Flash)         https://aistudio.google.com/apikey
    # PAID  → ANTHROPIC_API_KEY (Claude, upgrade)   https://console.anthropic.com
    #
    # Provider + model are read from pr-review-orchestrator.config.json (committed).
    # Override here only if needed:
    # PR_REVIEW_PROVIDER: groq
  script:
    - npm ci
    - |
      if [ -n "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" ]; then
        git diff origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME...HEAD > pr.diff
      else
        git diff HEAD~1...HEAD > pr.diff
      fi
    - npx pr-review-orchestrator review --diff ./pr.diff --format github-pr > review.json
    - cat review.json
    # Uncomment to block pipeline on critical/high findings:
    # - node -e "const r=JSON.parse(require('fs').readFileSync('review.json','utf8')); if((r.summary?.critical_count??0)>0||(r.summary?.high_count??0)>0)process.exit(1);"
  artifacts:
    paths:
      - review.json
`;
}

async function updatePackageJson(rootDir: string, installSource: string, result: InitResult): Promise<void> {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!(await pathExists(packageJsonPath))) return;

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  packageJson.scripts ??= {};
  packageJson.devDependencies ??= {};

  // Add library to devDependencies so `npm ci` in CI installs it automatically
  if (!packageJson.devDependencies["pr-review-orchestrator"]) {
    packageJson.devDependencies["pr-review-orchestrator"] = installSource;
  }

  if (!packageJson.scripts["pr:review"]) {
    packageJson.scripts["pr:review"] = "git diff origin/main...HEAD | pr-review-orchestrator review --stdin --format github-pr";
  }

  if (!packageJson.scripts["pr:review:dry"]) {
    packageJson.scripts["pr:review:dry"] = "git diff origin/main...HEAD | pr-review-orchestrator review --stdin --dry-run";
  }

  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  result.updatedFiles.push(packageJsonPath);
}

async function updateGitIgnore(rootDir: string, result: InitResult): Promise<void> {
  const gitIgnorePath = path.join(rootDir, ".gitignore");

  // .pr-review-orchestrator is the secrets file — must be gitignored
  const entries = [".env", ".env.local", ".env.*.local", ".pr-review-orchestrator", "pr.diff", "review.json"];

  const existing = (await pathExists(gitIgnorePath)) ? await fs.readFile(gitIgnorePath, "utf8") : "";

  const lines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );

  const missing = entries.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;

  const next = [existing.trimEnd(), ...missing].filter(Boolean).join("\n") + "\n";
  await fs.writeFile(gitIgnorePath, next, "utf8");
  result.updatedFiles.push(gitIgnorePath);
}

export async function initProject(options: InitOptions = {}): Promise<InitResult> {
  const rootDir = path.resolve(options.targetDir || process.cwd());
  const topLevel = await fs.readdir(rootDir);
  const repoTypes = detectRepoTypes(new Set(topLevel));
  const result: InitResult = {
    rootDir,
    detectedRepoTypes: repoTypes,
    writtenFiles: [],
    updatedFiles: [],
    skippedFiles: []
  };

  const ci = options.ci || "github";

  // Secrets + model config — GITIGNORED, filled in by developer
  await writeFileIfMissing(
    path.join(rootDir, ".pr-review-orchestrator"),
    buildAiConfig(),
    result
  );

  // Public config — committed to git, no secrets
  await writeFileIfMissing(
    path.join(rootDir, "pr-review-orchestrator.config.json"),
    buildConfig(repoTypes),
    result
  );

  if (ci === "github" || ci === "both") {
    await writeFileIfMissing(
      path.join(rootDir, ".github", "workflows", "pr-review-orchestrator.yml"),
      buildGithubWorkflow(),
      result
    );
  }

  if (ci === "gitlab" || ci === "both") {
    await writeFileIfMissing(
      path.join(rootDir, "pr-review-orchestrator.gitlab-ci.yml"),
      buildGitlabCi(),
      result
    );
  }

  // installSource is what gets written into devDependencies.
  // "latest" works once published to npm. Until then the user sets it to their GitHub URL.
  const installSource = options.installSource ?? "latest";
  await updatePackageJson(rootDir, installSource, result);
  await updateGitIgnore(rootDir, result);

  return result;
}
