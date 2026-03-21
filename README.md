# PR Review Orchestrator

TypeScript-first PR review library and CLI for React, Node.js, Python, Java, and mixed monorepos.

## What You Can Use It As

- an installable CLI tool
- a reusable TypeScript library
- a CI helper for GitHub Actions or GitLab CI
- a backend service behind your React app

## Main Goal

This tool now supports PR review reports shaped for GitHub or GitLab automation.

Each reported issue can include:

- filename
- line number
- issue title and message
- severity label like `critical`, `high`, `medium`, `low`
- corrected code suggestion
- PR-comment-ready body text

It also supports a free local multi-agent style pipeline.

## Free Multi-Agent Pipeline

The free version simulates specialist agents locally:

- `security` agent
- `bug` agent
- `logic` agent
- `types` agent
- `eslint` agent
- `quality` agent
- `fix` agent

Right now this gives you a strong low-cost baseline.
Later, the same architecture can be upgraded so those agents call paid LLM workflows.

## Install Modes

### 1. Use It As A Tool In Any Repo

```bash
npm install -D pr-review-orchestrator
```

Then auto-setup the current repo:

```bash
npx pr-review-orchestrator init
```

That generates:

- `pr-review-orchestrator.config.json`
- `.env.example`
- `.github/workflows/pr-review-orchestrator.yml`
- `pr-review-orchestrator.gitlab-ci.yml`
- package.json scripts like `pr:review`

Then copy `.env.example` to `.env` in the repo root and add your `GROQ_API_KEY` or `ANTHROPIC_API_KEY`.

The generated GitHub workflow can also post PR comments automatically.

### 2. Use It As A Library In Code

```bash
npm install pr-review-orchestrator
```

```ts
import { reviewDiff, initProject, buildGithubPRReviewReport } from "pr-review-orchestrator";

const result = await reviewDiff(diffText, {
  provider: "local"
});

if (!("parsed_files" in result)) {
  const report = buildGithubPRReviewReport(result);
  console.log(report.comments);
}
```

## CLI Commands

### Initialize Current Repo

```bash
npx pr-review-orchestrator init
```

Options:

```bash
npx pr-review-orchestrator init --provider openai --ci github
npx pr-review-orchestrator init --provider local --ci both
npx pr-review-orchestrator init --cwd ./my-repo
```

### Review A Diff File

```bash
npx pr-review-orchestrator review --diff ./pr.diff
```

### Review From Stdin

```bash
git diff origin/main...HEAD | npx pr-review-orchestrator review --stdin
```

### GitHub PR Comment Report Format

```bash
git diff origin/main...HEAD | npx pr-review-orchestrator review --stdin --format github-pr
```

### Dry Run

```bash
git diff origin/main...HEAD | npx pr-review-orchestrator review --stdin --dry-run
```

## Output You Asked For

The standard review JSON now includes PR comment data under:

- `reports.pr_comments`
- `reports.agent_runs`

Each PR comment entry includes:

- `file`
- `line`
- `title`
- `issue`
- `severity`
- `labels`
- `code_snippet`
- `corrected_code`
- `body`

This is the shape you can send into a GitHub PR comment publisher.

The example GitHub workflow already posts those comments automatically using the built-in `GITHUB_TOKEN`.

## Library API

### `reviewDiff(diffText, options)`

Returns the strict review JSON.

```ts
import { reviewDiff } from "pr-review-orchestrator";

const result = await reviewDiff(diffText, {
  provider: "openai"
});
```

### `buildGithubPRReviewReport(review)`

Converts a review result into a GitHub-comment-friendly report.

```ts
import { buildGithubPRReviewReport } from "pr-review-orchestrator";

const report = buildGithubPRReviewReport(reviewResult);
```

### `initProject(options)`

Initializes the current repo with config and CI templates.

```ts
import { initProject } from "pr-review-orchestrator";

const setup = await initProject({
  provider: "openai",
  ci: "github"
});
```

## What `init` Automatically Sets Up

The `init` command detects the repo type and writes starter files.

Repo detection includes:

- React / Node via `package.json`
- Python via `pyproject.toml` or `requirements.txt`
- Java via `pom.xml` or `build.gradle`

Generated config includes:

- include paths based on repo type
- provider choice
- CI fail thresholds
- generated PR review scripts

## Repo Integration Examples

### React Repo

```bash
npm install -D pr-review-orchestrator
npx pr-review-orchestrator init --provider openai --ci github
npm run pr:review
```

Good for:

- unsafe HTML rendering
- client-side secret leaks
- risky fetch usage
- validation gaps

### Node Repo

```bash
npm install -D pr-review-orchestrator
npx pr-review-orchestrator init --provider openai --ci github
npm run pr:review
```

Good for:

- auth regressions
- async error handling
- SQL injection risks
- env and filesystem issues

### Python Repo

Even in a Python repo, you can still install and run this tool with Node.

```bash
npm install -D pr-review-orchestrator
npx pr-review-orchestrator init --provider openai --ci gitlab
npx pr-review-orchestrator review --diff ./pr.diff --format github-pr
```

### Java Repo

```bash
npm install -D pr-review-orchestrator
npx pr-review-orchestrator init --provider openai --ci github
npx pr-review-orchestrator review --diff ./pr.diff --format github-pr
```

### Monorepo

```bash
npm install -D pr-review-orchestrator
npx pr-review-orchestrator init --provider openai --ci both
git diff origin/main...HEAD | npx pr-review-orchestrator review --stdin --format github-pr
```

## React App Integration

Use the browser only for UI. Run the actual review on the server.

```ts
import express from "express";
import { reviewDiff, buildGithubPRReviewReport } from "pr-review-orchestrator";

const app = express();
app.use(express.json());

app.post("/review", async (req, res) => {
  const result = await reviewDiff(req.body.diff, {
    provider: process.env.PR_REVIEW_PROVIDER || "local"
  });

  if ("parsed_files" in result) {
    res.json(result);
    return;
  }

  res.json({
    review: result,
    githubReport: buildGithubPRReviewReport(result)
  });
});
```

## Environment Variables

The CLI now auto-loads env files from the repo root:

- `.env`
- `.env.local`
- `.env.pr-review-orchestrator`
- `.env.pr-review-orchestrator.local`

Main variables:

- `PR_REVIEW_PROVIDER=multi-agent|claude|groq|gemini|ollama|openai|local`
- `GROQ_API_KEY=...`
- `ANTHROPIC_API_KEY=...`
- `OPENAI_API_KEY=...`
- `GEMINI_API_KEY=...`

## What You Need For Demo

For a free demo, you do not need any OpenAI API key.

Use:

- `PR_REVIEW_PROVIDER=local`
- GitHub Actions default `GITHUB_TOKEN` for posting PR comments

That means:

- no paid LLM required
- no extra agent service required
- no extra API key required for GitHub comment posting inside GitHub Actions

You can start with `GROQ_API_KEY` in `.env`, and later upgrade by adding `ANTHROPIC_API_KEY` without changing your repo setup.

## Supported File Types

- React / frontend: `.tsx`, `.jsx`, `.css`, `.scss`, `.sass`, `.less`
- Node / JS / TS: `.ts`, `.js`, `.mjs`, `.cjs`
- Python: `.py`
- Java: `.java`
- Kotlin: `.kt`
- Config / dependency: `.json`, `.yml`, `.yaml`, `.xml`, `.gradle`, `.properties`

## Paid Upgrade Path Later

When you want to upgrade for company use, the next clean step is:

- keep the same CLI and report format
- replace or extend local agents with paid LLM agents
- add specialized paid reviewers for security, logic, types, ESLint, performance, and fix generation
- optionally add GitHub App posting for inline comments automatically

That means the free version is not wasted work. It becomes the base platform.

## Local Development

```bash
npm install
npm run build
npm run review:file
npm run check
```

## Notes

- Source code is TypeScript-only.
- Runtime output is compiled to `dist/`.
- If the model response is invalid JSON, the tool falls back to the local multi-agent pipeline.
