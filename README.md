# PR Review Orchestrator

[![npm version](https://img.shields.io/npm/v/pr-review-orchestrator.svg)](https://www.npmjs.com/package/pr-review-orchestrator)
[![npm downloads](https://img.shields.io/npm/dm/pr-review-orchestrator.svg)](https://www.npmjs.com/package/pr-review-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)

> Multi-agent AI code review system that automatically reviews every pull request. **8 specialized agents + a Judge Agent** run in parallel on each PR — finding security issues, bugs, logic flaws, type errors, performance problems, and more. Works with any repository: React, Node.js, Python, Java, Go, and more.

---

## Table of Contents

- [How It Works](#how-it-works)
- [8 Specialized Agents](#8-specialized-agents)
- [The Judge Agent](#the-judge-agent)
- [Quick Start — 60 Seconds](#quick-start--60-seconds)
- [AI Providers](#ai-providers)
- [Setup by Repository Type](#setup-by-repository-type)
  - [React / Next.js](#-reactnextjs)
  - [Node.js / Express](#-nodejs--express)
  - [Python](#-python)
  - [Java](#-java)
  - [Any Other Language](#-any-other-language)
- [GitHub Actions Integration](#github-actions-integration)
- [Library API](#library-api)
- [CLI Reference](#cli-reference)
- [HTML Report](#html-report)
- [Configuration](#configuration)
- [Output Format](#output-format)

---

## How It Works

Every time a PR is opened, this system runs a **6-step review pipeline**:

```
┌─────────────────────────────────────────────────────┐
│                  PR DIFF RECEIVED                   │
└──────────────────────┬──────────────────────────────┘
                       │
         ┌─────────────▼──────────────┐
         │  STEP 1 — DETECTION        │
         │  8 agents run in parallel  │
         │  each focused on one domain│
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────┐
         │  STEP 2 — AGGREGATION      │
         │  Merge duplicate findings  │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────┐
         │  STEP 3 — DECISION ENGINE  │
         │  Assign severity + score   │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────┐
         │  STEP 4 — CONTEXT CHECK    │
         │  Full file review, not     │
         │  just the changed lines    │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────┐
         │  STEP 5 — JUDGE AGENT      │
         │  Group same-type issues    │
         │  Remove false positives    │
         │  Score agents, retry weak  │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────┐
         │  STEP 6 — FIX GENERATION   │
         │  Concrete corrected code   │
         │  for every issue found     │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────┐
         │     BUNDLED PR REPORT      │
         │  One comment, all agents   │
         │  grouped by type + agent   │
         └────────────────────────────┘
```

---

## 8 Specialized Agents

Each agent has a single focused job. Running 8 narrow agents in parallel produces far better results than one "review everything" prompt.

| Agent | Finds |
|---|---|
| 🛡️ **Security** | Hardcoded secrets, XSS vectors, SQL injection, unsafe HTML, credential leaks in URLs, iframe/image injection |
| 🐛 **Bug** | Infinite loops, object mutation bugs, missing `await`, race conditions, missing cleanup in `useEffect` |
| 🧠 **Logic** | Assignment instead of comparison (`=` vs `==`), loose equality, always-true/false conditions, validation fall-through |
| 📐 **Types** | `props:any`, `useState<any>`, event handlers typed as `any`, missing return types, unsafe type assertions |
| ⚡ **Performance** | Heavy computation in render, `Math.random()` in JSX, missing `useMemo`/`useCallback`, `Date.now()` in render |
| 🔍 **ESLint** | `console.log` left in code, unused variables/imports, useless `onClick` handlers, missing hook dependencies |
| ✅ **Best Practices** | Hardcoded URLs/credentials, auth logic in UI components, missing error handling, oversized components |
| 🏗️ **Quality** | Side effects in render body, `useEffect` without deps array, missing loading/error states, unstable list keys |

---

## The Judge Agent

After all 8 agents finish, the **Judge Agent** runs a quality pass:

- **Groups** repeated same-type findings into one entry — e.g. 4× "Loose any typing" at different lines becomes *"Multiple `any` type usages · Lines 7, 10, 27, 32"*
- **Removes** false positives and out-of-scope findings
- **Detects gaps** — issues that exist in the code but no agent caught
- **Scores** each agent 0–1 and flags underperformers
- **Retries** weak agents with targeted prompts: *"You missed: heavy() called in JSX at line 80 — please re-examine"*

---

## Quick Start — 60 Seconds

### Step 1 — Install

```bash
npm install -D pr-review-orchestrator
```

### Step 2 — Set up your repo

```bash
npx pr-review-orchestrator init
```

This auto-detects your repo type and generates:
- `.github/workflows/pr-review.yml` — GitHub Actions workflow
- `pr-review-orchestrator/init.json` — config file
- `.env.example` — API key template

### Step 3 — Add a free API key

Get a free key from [console.groq.com](https://console.groq.com) (no credit card needed).

**For local development** — add it to `pr-review-orchestrator/init.json` (auto-generated by `init`):
```json
{
  "apiKeys": {
    "groq": "gsk_your_key_here"
  }
}
```

**For GitHub Actions (CI)** — add it as a repository secret: **Settings → Secrets and variables → Actions → `GROQ_API_KEY`**

> **Why both?** The `init.json` file is used when running reviews locally. GitHub Actions cannot read your local files — it reads secrets from the repository settings instead. You need **both** if you want the review to work locally AND in CI.

### Step 4 — Open a PR

Every new PR will now get an automatic review comment like this:

```
## 🔍 PR Review Orchestrator
🚫 Changes Requested

| Files | Issues | 🔴 Critical | 🟠 High | 🟡 Medium | 🔵 Low |
|---|---|---|---|---|---|
| 1 | 12 | 2 | 3 | 4 | 3 |

### 🤖 Agent Pipeline
| Agent | Scope | Findings |
|---|---|---|
| 🛡️ Security | secrets, XSS, injection | 🔴🔴🟠 3 |
| 🧠 Logic | wrong conditions, loose equality | 🔴🟠 2 |
...

### 📋 Findings by Agent
<details open>
<summary>🛡️ Security — 3 issues  🔴 2  🟠 1</summary>
...
</details>
```

---

## AI Providers

No AI key? No problem — the local pattern engine runs for free.

| Provider | Cost | How to get key | Quality |
|---|---|---|---|
| **Groq** (recommended) | Free tier | [console.groq.com](https://console.groq.com) | ⭐⭐⭐⭐ |
| **Gemini** | Free tier | [aistudio.google.com](https://aistudio.google.com) | ⭐⭐⭐⭐ |
| **Claude** (Anthropic) | Paid | [console.anthropic.com](https://console.anthropic.com) | ⭐⭐⭐⭐⭐ |
| **OpenAI** | Paid | [platform.openai.com](https://platform.openai.com) | ⭐⭐⭐⭐⭐ |
| **Ollama** | Free (local) | [ollama.com](https://ollama.com) | ⭐⭐⭐ |
| **Local patterns** | Free (offline) | No key needed | ⭐⭐ |

The system auto-detects which provider to use based on which key is set. Priority order:

```
ANTHROPIC_API_KEY → GROQ_API_KEY → GEMINI_API_KEY → OLLAMA_HOST → OPENAI_API_KEY → local
```

---

## Setup by Repository Type

### ⚛️ React/Next.js

```bash
# Install
npm install -D pr-review-orchestrator

# Auto-setup
npx pr-review-orchestrator init --provider groq --ci github

# Add to .env
echo "GROQ_API_KEY=your_key_here" >> .env
```

**GitHub Actions workflow** (auto-generated at `.github/workflows/pr-review.yml`):

```yaml
name: PR Review
on:
  pull_request:
    types: [opened, synchronize]

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

      - name: Run PR Review
        run: |
          git diff origin/${{ github.base_ref }}...HEAD > pr.diff
          npx pr-review-orchestrator --diff pr.diff --format github-pr > review.json
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}

      - name: Post Review Comment
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('review.json', 'utf8'));
            const body = report.bundled_comment || report.summary_comment;
            if (body) {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body
              });
            }
```

**What it catches in React/Next.js:**
- `dangerouslySetInnerHTML` with unsanitized props
- `Math.random()` / `Date.now()` called on every render
- `useState<any>` and untyped event handlers
- Side effects written directly in the component body
- `javascript:` URLs in `href` attributes
- Missing `useCallback` for handlers passed to children

---

### 🟢 Node.js / Express

```bash
npm install -D pr-review-orchestrator
npx pr-review-orchestrator init --provider groq --ci github
```

**What it catches in Node.js:**
- SQL/command injection via string interpolation
- Hardcoded secrets and API keys
- Unhandled promise rejections
- Missing `await` on async database calls
- `console.log` with sensitive data left in production

**Use as a library in your Node app:**

```typescript
import { reviewDiff, buildGithubPRReviewReport } from "pr-review-orchestrator";
import { readFileSync } from "fs";

const diff = readFileSync("./pr.diff", "utf8");
const result = await reviewDiff(diff);

const report = buildGithubPRReviewReport(result);
console.log(`Decision: ${result.summary.final_decision}`);
console.log(`Issues: ${result.summary.total_issues}`);
console.log(report.bundled_comment);
```

**Express API server:**

```typescript
import express from "express";
import { reviewDiff, buildGithubPRReviewReport } from "pr-review-orchestrator";

const app = express();
app.use(express.json());

app.post("/review", async (req, res) => {
  const result = await reviewDiff(req.body.diff);
  const report = buildGithubPRReviewReport(result);

  res.json({
    decision:  result.summary.final_decision,   // "approve" | "request_changes"
    issues:    result.summary.total_issues,
    critical:  result.summary.critical_count,
    report:    report.bundled_comment           // markdown string for posting to GitHub
  });
});

app.listen(3000);
```

---

### 🐍 Python

Your Python code never needs to change. This tool runs as a separate Node.js process alongside your Python repo.

**Option 1 — GitHub Actions (recommended, zero local setup)**

Add this workflow to your Python repo at `.github/workflows/pr-review.yml`:

```yaml
name: PR Review
on:
  pull_request:
    types: [opened, synchronize]

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

      - name: Run PR Review
        run: |
          git diff origin/${{ github.base_ref }}...HEAD > pr.diff
          npx pr-review-orchestrator --diff pr.diff --format github-pr > review.json
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}

      - name: Post Comment
        uses: actions/github-script@v7
        with:
          script: |
            const report = JSON.parse(require('fs').readFileSync('review.json', 'utf8'));
            if (report.bundled_comment) {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body: report.bundled_comment
              });
            }
```

**Option 2 — Call from Python script**

```python
import subprocess
import json

def review_diff(diff_text: str) -> dict:
    """Run pr-review-orchestrator and return the JSON result."""
    result = subprocess.run(
        ["npx", "pr-review-orchestrator", "--stdin", "--format", "json"],
        input=diff_text,
        capture_output=True,
        text=True,
        timeout=120
    )
    return json.loads(result.stdout)

# Usage
with open("pr.diff") as f:
    diff = f.read()

review = review_diff(diff)
print(f"Decision: {review['summary']['final_decision']}")
print(f"Total issues: {review['summary']['total_issues']}")

for finding in review['reports']['findings']:
    print(f"[{finding['severity'].upper()}] {finding['title']} — {finding['file']}:{finding['line']}")
```

**Option 3 — Get the diff from Python and review it**

```python
import subprocess
import json

# Get the diff
diff = subprocess.run(
    ["git", "diff", "origin/main...HEAD"],
    capture_output=True, text=True
).stdout

# Review it
review_process = subprocess.run(
    ["npx", "pr-review-orchestrator", "--stdin"],
    input=diff,
    capture_output=True, text=True
)

result = json.loads(review_process.stdout)
decision = result["summary"]["final_decision"]  # "approve" or "request_changes"

if decision == "request_changes":
    print("❌ Review failed — blocking issues found")
    exit(1)
else:
    print("✅ Review passed")
```

**What it catches in Python repos:**
- SQL injection via f-strings or `.format()` in queries
- Hardcoded passwords and API keys
- Unsafe `eval()` or `exec()` calls
- Missing error handling in file I/O
- Sensitive data written to logs

---

### ☕ Java

**Option 1 — GitHub Actions (recommended)**

Add `.github/workflows/pr-review.yml` to your Java repo:

```yaml
name: PR Review
on:
  pull_request:
    types: [opened, synchronize]

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

      - name: Run PR Review
        run: |
          git diff origin/${{ github.base_ref }}...HEAD > pr.diff
          npx pr-review-orchestrator --diff pr.diff --format github-pr > review.json
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}

      - name: Post Comment
        uses: actions/github-script@v7
        with:
          script: |
            const report = JSON.parse(require('fs').readFileSync('review.json', 'utf8'));
            if (report.bundled_comment) {
              await github.rest.issues.createComment({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: context.issue.number, body: report.bundled_comment
              });
            }
```

**Option 2 — Call from Java**

```java
import java.io.*;
import java.util.*;

public class PRReviewer {

    public static String reviewDiff(String diffText) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(
            "npx", "pr-review-orchestrator", "--stdin", "--format", "json"
        );
        pb.environment().put("GROQ_API_KEY", System.getenv("GROQ_API_KEY"));
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Write diff to stdin
        try (OutputStream os = process.getOutputStream()) {
            os.write(diffText.getBytes());
        }

        // Read JSON output
        String output = new String(process.getInputStream().readAllBytes());
        process.waitFor();
        return output;
    }

    public static void main(String[] args) throws Exception {
        // Get the diff
        Process gitDiff = new ProcessBuilder("git", "diff", "origin/main...HEAD").start();
        String diff = new String(gitDiff.getInputStream().readAllBytes());

        // Review it
        String reviewJson = reviewDiff(diff);
        System.out.println(reviewJson);
    }
}
```

**Using with Maven (add to your CI pipeline):**

```xml
<!-- pom.xml — add a pre-test phase to run the review -->
<plugin>
  <groupId>org.codehaus.mojo</groupId>
  <artifactId>exec-maven-plugin</artifactId>
  <executions>
    <execution>
      <id>pr-review</id>
      <phase>validate</phase>
      <goals><goal>exec</goal></goals>
      <configuration>
        <executable>npx</executable>
        <arguments>
          <argument>pr-review-orchestrator</argument>
          <argument>--diff</argument>
          <argument>pr.diff</argument>
        </arguments>
      </configuration>
    </execution>
  </executions>
</plugin>
```

**What it catches in Java repos:**
- SQL injection via string concatenation in JDBC queries
- Hardcoded credentials in `application.properties`
- Missing null checks before method calls
- Unchecked exceptions swallowed silently
- Sensitive data logged with `System.out.println`

---

### 🌐 Any Other Language

The tool runs as a standalone CLI that works with **any** repository language because it reviews the **git diff**, not the runtime.

```bash
# Go repo
git diff origin/main...HEAD | npx pr-review-orchestrator --stdin

# Ruby repo
git diff origin/main...HEAD | npx pr-review-orchestrator --stdin

# Rust repo
git diff origin/main...HEAD | npx pr-review-orchestrator --stdin

# PHP repo
git diff origin/main...HEAD | npx pr-review-orchestrator --stdin
```

---

## GitHub Actions Integration

### Full Workflow with Inline + Bundled Comments

```yaml
name: PR Review Orchestrator
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  contents: read

jobs:
  review:
    name: AI Code Review
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Generate diff
        run: git diff origin/${{ github.base_ref }}...HEAD > pr.diff

      - name: Run review
        run: npx pr-review-orchestrator --diff pr.diff --format github-pr > review.json
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          # Or use: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY

      - name: Post bundled comment
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('review.json', 'utf8'));

            // Post one bundled comment with all findings grouped by agent
            const body = report.bundled_comment;
            if (!body) return;

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body
            });

            // Optional: fail the check if critical/high issues were found
            const decision = report.summary?.final_decision;
            if (decision === 'request_changes') {
              core.setFailed(`PR Review: ${report.summary.critical_count} critical, ${report.summary.high_count} high issues found`);
            }
```

---

## Library API

### `reviewDiff(diffText, options?)`

The main function. Takes a unified diff string and returns a full review result.

```typescript
import { reviewDiff } from "pr-review-orchestrator";

const result = await reviewDiff(diffText, {
  provider: "groq",    // optional — auto-detected from env if omitted
  dryRun: false        // true = parse only, no AI call
});

console.log(result.summary.final_decision);   // "approve" | "request_changes"
console.log(result.summary.total_issues);     // number
console.log(result.reports.findings);         // all findings, flat list
```

### `buildGithubPRReviewReport(result)`

Converts a `ReviewResult` into a GitHub-ready report.

```typescript
import { buildGithubPRReviewReport } from "pr-review-orchestrator";

const report = buildGithubPRReviewReport(result);

report.bundled_comment    // ONE markdown comment with all findings grouped by agent
report.comments           // inline comments per diff line (optional)
report.summary            // counts: total, critical, high, medium, low
```

### `buildHTMLReport(result)`

Generates a self-contained HTML page with CSS-styled issue cards.

```typescript
import { buildHTMLReport } from "pr-review-orchestrator";
import { writeFileSync } from "fs";

const html = buildHTMLReport(result);
writeFileSync("review-report.html", html);
```

### `detectAvailableAI()`

Check which AI provider is currently configured.

```typescript
import { detectAvailableAI } from "pr-review-orchestrator";

const ai = detectAvailableAI();
// Returns: "claude" | "groq" | "gemini" | "ollama" | "openai" | "none"
```

---

## CLI Reference

```bash
# Initialize current repo
npx pr-review-orchestrator init

# Review a diff file
npx pr-review-orchestrator --diff ./pr.diff

# Review from git directly
git diff origin/main...HEAD | npx pr-review-orchestrator --stdin

# Output as GitHub PR comment format
npx pr-review-orchestrator --diff pr.diff --format github-pr

# Output as HTML
npx pr-review-orchestrator --diff pr.diff --format html

# Use a specific provider
npx pr-review-orchestrator --diff pr.diff --provider groq

# Dry run (parse only, no AI)
npx pr-review-orchestrator --diff pr.diff --dry-run
```

### Init Options

```bash
npx pr-review-orchestrator init --provider groq       # use Groq (free)
npx pr-review-orchestrator init --provider gemini     # use Gemini (free)
npx pr-review-orchestrator init --provider anthropic  # use Claude
npx pr-review-orchestrator init --provider local      # no AI, pattern-based
npx pr-review-orchestrator init --ci github           # generate GitHub Actions workflow
npx pr-review-orchestrator init --ci gitlab           # generate GitLab CI config
npx pr-review-orchestrator init --ci both             # generate both
```

---

## HTML Report

Generate a dark-themed visual report with issue cards, severity colors, and code blocks:

```typescript
import { reviewDiff, buildHTMLReport } from "pr-review-orchestrator";
import { writeFileSync } from "fs";

const result = await reviewDiff(diffText);
const html   = buildHTMLReport(result);

writeFileSync("./review.html", html);
// open review.html in any browser — no server needed
```

The HTML report includes:
- Decision badge (✅ Approved / 🚫 Changes Requested)
- Summary stats grid with severity counts
- Agent pipeline table with per-agent finding counts
- Collapsible finding cards grouped by file
- Severity-coded left borders (red, orange, yellow, blue)
- Confidence bar per finding
- Fix code blocks with syntax highlighting

---

## Configuration

After running `npx pr-review-orchestrator init`, a config file is created at `pr-review-orchestrator/init.json`:

```json
{
  "provider": "multi-agent",
  "selectedProvider": "groq",
  "model": "llama-3.3-70b-versatile",
  "review": {
    "includePaths": ["src", "app"],
    "failOnSeverity": ["critical", "high"]
  },
  "apiKeys": {
    "groq": "",
    "anthropic": "",
    "gemini": "",
    "openai": "",
    "ollamaHost": ""
  }
}
```

### Environment Variables

```bash
# AI Provider keys (set whichever you have)
GROQ_API_KEY=gsk_...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...
OPENAI_API_KEY=sk-...
OLLAMA_HOST=http://localhost:11434

# Override provider
PR_REVIEW_PROVIDER=groq
```

Auto-loaded from these files (first found wins):
```
.env
.env.local
.env.pr-review-orchestrator
.env.pr-review-orchestrator.local
pr-review-orchestrator/init.json
```

---

## Output Format

The full `ReviewResult` JSON structure returned by `reviewDiff()`:

```typescript
{
  // Per-file findings
  files: [{
    file: "src/login.tsx",
    language: "TypeScript",
    changed_lines: [10, 11, 12, ...],
    triage: {
      risk_level: "high",           // "low" | "medium" | "high"
      areas_of_concern: ["auth", "security"]
    },
    review: {
      issues: [...]                 // bug, logic, types, performance, eslint findings
    },
    security: {
      vulnerabilities: [...]        // security agent findings
    },
    fix: {
      required: true,
      patches: [{ file, line, original, fixed }]
    }
  }],

  // Summary counts
  summary: {
    total_files: 1,
    total_issues: 12,
    critical_count: 2,
    high_count: 3,
    medium_count: 4,
    low_count: 3,
    final_decision: "request_changes"  // "approve" | "request_changes"
  },

  // Pre-formatted reports
  reports: {
    findings: [...],                   // flat deduplicated list of all issues
    pr_comments: [...],                // GitHub PR comment format
    agent_runs: [...],                 // per-agent finding counts
    files: [...],                      // per-file severity breakdown
    markdown_summary: "..."            // markdown text for CI logs
  }
}
```

### Per-finding structure:

```typescript
{
  id:             "R-ai-bug-src/login.tsx-42",
  agent:          "bug",              // which agent found it
  category:       "bug",             // bug | security | performance | quality
  severity:       "high",            // critical | high | medium | low
  confidence:     0.85,              // 0.0 – 1.0
  file:           "src/login.tsx",
  line:           42,
  title:          "Infinite loop blocks UI thread",
  issue:          "The freeze() function contains while(true)...",
  code_snippet:   "while(true){}",
  corrected_code: "// Remove this function entirely",
  labels:         ["bug", "high"]
}
```

---

## Supported Languages

| Language | Extensions |
|---|---|
| TypeScript | `.ts`, `.tsx` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `.py` |
| Java | `.java` |
| Kotlin | `.kt` |
| Go | `.go` |
| Ruby | `.rb` |
| PHP | `.php` |
| Rust | `.rs` |
| C# | `.cs` |
| CSS/SCSS | `.css`, `.scss`, `.sass`, `.less` |
| Config | `.json`, `.yml`, `.yaml`, `.xml`, `.env` |

---

## Local Development

```bash
git clone https://github.com/monudaksh/pr-review-orchestrator
cd pr-review-orchestrator
npm install
npm run build

# Test against a sample diff
npm run review:file

# Test with dry run (no AI call)
npm run check

# Run the Express API server
npm run api:dev
```

---

## License

MIT © [Monu Daksh](https://github.com/monudaksh)
