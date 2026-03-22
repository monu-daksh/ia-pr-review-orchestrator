import fs from "node:fs/promises";
import path from "node:path";
import type { InstallProviderChoice } from "../types.js";

const TOOL_DIR = "pr-review-orchestrator";
const PROJECT_CONFIG_NAME = "config.json";
const LOCAL_CONFIG_NAME = "local.json";

interface InitOptions {
  targetDir?: string;
  ci?: "github" | "gitlab" | "both" | "none";
  installSource?: string;
  providerChoice?: InstallProviderChoice;
  model?: string;
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

function getRequiredEnv(providerChoice: InstallProviderChoice): string | null {
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
      return null;
  }
}

function buildLocalConfig(providerChoice: InstallProviderChoice, model: string): string {
  return JSON.stringify(
    {
      provider: providerChoice === "local" ? "local" : "multi-agent",
      selectedProvider: providerChoice,
      models: {
        groq: providerChoice === "groq" ? model : getDefaultModel("groq"),
        anthropic: providerChoice === "anthropic" ? model : getDefaultModel("anthropic"),
        gemini: providerChoice === "gemini" ? model : getDefaultModel("gemini"),
        openai: providerChoice === "openai" ? model : getDefaultModel("openai"),
        ollama: providerChoice === "ollama" ? model : getDefaultModel("ollama")
      },
      apiKeys: {
        groq: providerChoice === "groq" ? "your_groq_api_key_here" : "",
        gemini: providerChoice === "gemini" ? "your_gemini_api_key_here" : "",
        anthropic: providerChoice === "anthropic" ? "your_anthropic_api_key_here" : "",
        openai: providerChoice === "openai" ? "your_openai_api_key_here" : "",
        ollamaHost: providerChoice === "ollama" ? "http://localhost:11434" : ""
      }
    },
    null,
    2
  ) + "\n";
}

function buildProjectConfig(repoTypes: string[], providerChoice: InstallProviderChoice, model: string): string {
  const include = repoTypes.includes("react")
    ? ["src", "app", "components", "pages", "server", "api"]
    : repoTypes.includes("python")
      ? ["src", "app", "services", "tests"]
      : repoTypes.includes("java")
        ? ["src/main", "src/test"]
        : ["src", "server", "api"];

  return JSON.stringify(
    {
      provider: providerChoice === "local" ? "local" : "multi-agent",
      install: {
        toolDirectory: TOOL_DIR,
        localConfigFile: `${TOOL_DIR}/${LOCAL_CONFIG_NAME}`,
        projectConfigFile: `${TOOL_DIR}/${PROJECT_CONFIG_NAME}`,
        providerChoice,
        selectedModel: model,
        requiredEnv: getRequiredEnv(providerChoice)
      },
      review: {
        includePaths: include,
        maxContextLines: 12
      },
      ci: {
        failOnSeverity: []
      },
      repo: {
        detectedTypes: repoTypes
      }
    },
    null,
    2
  ) + "\n";
}

function buildGithubWorkflow(): string {
  return `name: PR Review Orchestrator

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:

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
        run: npm install

      - name: Run AI review
        env:
          GROQ_API_KEY: \${{ secrets.GROQ_API_KEY }}
          GROQ_MODEL: \${{ secrets.GROQ_MODEL }}
          GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
          GEMINI_MODEL: \${{ secrets.GEMINI_MODEL }}
          OLLAMA_HOST: \${{ secrets.OLLAMA_HOST }}
          OLLAMA_MODEL: \${{ secrets.OLLAMA_MODEL }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          ANTHROPIC_MODEL: \${{ secrets.ANTHROPIC_MODEL }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          OPENAI_MODEL: \${{ secrets.OPENAI_MODEL }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
        run: |
          git diff origin/\${{ github.base_ref }}...HEAD > pr.diff
          npx pr-review-orchestrator review --diff ./pr.diff --format github-pr > review.json

      - name: Print review summary
        run: node -e "const r=JSON.parse(require('fs').readFileSync('review.json','utf8')); console.log(r.reports?.markdown_summary ?? 'No summary generated');"

      - name: Post PR Review Comments
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
                body: review.summary?.total_issues > 0
                  ? review.reports?.markdown_summary || 'PR review completed.'
                  : 'PR Review Orchestrator: no high-confidence findings in this diff.'
              });
            }

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
  script:
    - npm ci
    - git diff origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME...HEAD > pr.diff
    - npx pr-review-orchestrator review --diff ./pr.diff --format github-pr > review.json
    - cat review.json
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

  if (!packageJson.devDependencies["pr-review-orchestrator"]) {
    packageJson.devDependencies["pr-review-orchestrator"] = installSource;
  }

  if (!packageJson.scripts["pr:review"]) {
    packageJson.scripts["pr:review"] = "git diff origin/main...HEAD | pr-review-orchestrator review --stdin --format github-pr";
  }

  if (!packageJson.scripts["pr:review:dry"]) {
    packageJson.scripts["pr:review:dry"] = "git diff origin/main...HEAD | pr-review-orchestrator review --stdin --dry-run";
  }

  if (!packageJson.scripts["pr:review:init"]) {
    packageJson.scripts["pr:review:init"] = "pr-review-orchestrator init";
  }

  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  result.updatedFiles.push(packageJsonPath);
}

async function updateGitIgnore(rootDir: string, result: InitResult): Promise<void> {
  const gitIgnorePath = path.join(rootDir, ".gitignore");
  const entries = [
    ".env",
    ".env.local",
    ".env.*.local",
    `${TOOL_DIR}/${LOCAL_CONFIG_NAME}`,
    ".pr-review-orchestrator",
    "pr.diff",
    "review.json"
  ];
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
  const providerChoice = options.providerChoice ?? "groq";
  const model = options.model ?? getDefaultModel(providerChoice);
  const toolDirPath = path.join(rootDir, TOOL_DIR);

  await writeFileIfMissing(
    path.join(toolDirPath, LOCAL_CONFIG_NAME),
    buildLocalConfig(providerChoice, model),
    result
  );

  await writeFileIfMissing(
    path.join(toolDirPath, PROJECT_CONFIG_NAME),
    buildProjectConfig(repoTypes, providerChoice, model),
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

  const installSource = options.installSource ?? "latest";
  await updatePackageJson(rootDir, installSource, result);
  await updateGitIgnore(rootDir, result);

  return result;
}



