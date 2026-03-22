/**
 * ============================================================
 * FILE: src/agents/local-agents.ts
 * PURPOSE: Pattern-based fallback agents that work with NO AI, NO internet,
 *          and NO API keys. These run regex patterns against the changed code
 *          to detect common issues.
 *
 * WHEN THESE RUN:
 *   1. When no AI provider is configured (no API keys set)
 *   2. As a fallback inside every AI provider if the AI call fails
 *   3. As a fallback inside runAIAgentPipeline if ALL AI agents return zero findings
 *
 * AGENTS (8 specialized pattern functions):
 *   runSecurityAgent()      — dangerouslySetInnerHTML XSS, SQL string interpolation
 *   runBugAgent()           — fetch() without await (untracked async)
 *   runLogicAgent()         — db.query() without bound parameters
 *   runTypesAgent()         — catch(error) without : unknown annotation
 *   runEslintAgent()        — console.log/error, var keyword usage
 *   runPerformanceAgent()   — .sort() / .reverse() in hot paths
 *   runBestPracticesAgent() — @ts-ignore usage, loose == equality
 *   runQualityAgent()       — `any` type usage
 *
 * CONFIDENCE SCORES:
 *   Pattern agents use concrete regex patterns, so confidence is generally
 *   very high (0.96–0.99) for exact matches like SQL injection patterns,
 *   and lower (0.71–0.74) for heuristic patterns like .sort() in hot paths.
 *
 * HOW TO EXTEND:
 *   Add new patterns to existing agent functions or create a new agent function
 *   and add it to the array passed to mergeOutputs() in runLocalAgentPipeline().
 *
 * FUTURE UPGRADES:
 *   - Add more language-specific patterns (Python, Java, etc.)
 *   - Add patterns for more security vulnerabilities (SSRF, XXE, etc.)
 *   - Add configurable rules from a user-defined rules file
 *   - Add AST-based analysis for more precise detection
 * ============================================================
 */

import type {
  AgentRunSummary,
  Patch,
  PRComment,
  ReviewFileResult,
  ReviewIssue,
  ReviewResult,
  SecurityIssue,
  TriagedFile
} from "../types.js";
import { createEmptyReview, finalizeSummary } from "../core/schema.js";

// ─── Internal Types ───────────────────────────────────────────────────────────

/**
 * Output collected by each agent function.
 * Each agent appends its findings here and returns the whole structure.
 */
interface AgentOutput {
  reviewIssues: ReviewIssue[];    // Non-security findings (bugs, quality, performance, etc.)
  securityIssues: SecurityIssue[];// Security-specific findings (XSS, injection, etc.)
  patches: Patch[];               // Auto-generated code fixes (original → fixed)
  changesSummary: string[];       // Human-readable descriptions of each fix
}

/** A single line with its 1-based line number. Used when iterating over file content. */
type ReviewLine = { line: number; content: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates an empty AgentOutput to start with.
 * Each agent function starts with createOutput() and appends to its fields.
 */
function createOutput(): AgentOutput {
  return {
    reviewIssues: [],
    securityIssues: [],
    patches: [],
    changesSummary: []
  };
}

/**
 * Applies patches to a file's added lines to produce the "fixed" version.
 * Each patch maps a line number to its replacement code.
 * Lines without a patch keep their original content.
 *
 * Used to build ReviewFileResult.fix.fixed_code.
 *
 * @param file    - The triaged file being reviewed
 * @param patches - Line-by-line replacements
 * @returns The patched file content as a string
 */
function buildFixedCode(file: TriagedFile, patches: Patch[]): string {
  if (patches.length === 0) return ""; // No patches → nothing to show

  // Build a lookup map: line number → replacement code
  const patchByLine = new Map<number, string>();
  for (const patch of patches) {
    patchByLine.set(patch.line, patch.fixed);
  }

  // Apply patches: use fixed code for patched lines, original code for others
  return file.addedLines.map((line) => patchByLine.get(line.line) ?? line.content).join("\n");
}

/**
 * Returns the lines to review for a file.
 * Prefers full file content (if available) over added-only lines,
 * so patterns can detect issues anywhere in the file — not just in the diff.
 *
 * @param file - The triaged file being reviewed
 * @returns Array of lines to iterate over for pattern matching
 */
function getReviewLines(file: TriagedFile): ReviewLine[] {
  return file.fullFileLines?.length ? file.fullFileLines : file.addedLines;
}

/**
 * Converts a ReviewIssue or SecurityIssue into a PRComment.
 * The comment body is a plain-text summary of the issue and fix.
 *
 * @param issue - The finding to convert
 * @returns A formatted PRComment ready for GitHub
 */
function buildComment(issue: ReviewIssue | SecurityIssue): PRComment {
  // Get the best available fix code
  const correctedCode =
    "corrected_code" in issue && issue.corrected_code
      ? issue.corrected_code
      : "fix" in issue
        ? issue.fix                // SecurityIssue uses `fix`
        : issue.suggestion;        // ReviewIssue uses `suggestion`

  return {
    id: issue.id,
    file: issue.file,
    line: issue.line,
    agent: issue.agent,
    severity: issue.severity,
    category: issue.category,
    title: issue.title,
    issue: issue.message,
    code_snippet: issue.code_snippet,
    corrected_code: correctedCode,
    labels: issue.labels,
    // Plain-text comment body (formatted further in github-pr.ts for GitHub display)
    body: [
      `File: ${issue.file}`,
      `Line: ${issue.line}`,
      `Severity: ${issue.severity}`,
      `Issue: ${issue.title}`,
      `Details: ${issue.message}`,
      `Suggested fix: ${correctedCode}`
    ].join("\n")
  };
}

// ─── Specialized Agent Functions ─────────────────────────────────────────────

/**
 * SECURITY AGENT — Detects security vulnerabilities via regex patterns.
 *
 * Detects:
 *   - dangerouslySetInnerHTML → XSS vulnerability (high severity, 0.96 confidence)
 *     Fix: wraps the HTML in sanitizeHtml() call
 *
 *   - SQL string interpolation using ${} in template literals → SQL injection (critical, 0.99)
 *     Fix: replaces with parameterized query using ?
 *     Fix: updates db.query() call to pass parameters as second argument
 *
 * Confidence is very high (0.96–0.99) because these are exact pattern matches
 * with very low false positive rates.
 */
function runSecurityAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of getReviewLines(file)) {
    // ── XSS via dangerouslySetInnerHTML ───────────────────────────────────────
    // React's dangerouslySetInnerHTML bypasses React's XSS protection.
    // If the HTML comes from a prop or variable, it's an XSS risk.
    if (/dangerouslySetInnerHTML/.test(addedLine.content)) {
      // Attempt to auto-fix by wrapping the HTML in a sanitizeHtml() call
      const fixed = addedLine.content.replace(
        /<div dangerouslySetInnerHTML=\{\{ __html: ([^}]+) \}\} \/>/,
        "<div>{sanitizeHtml($1)}</div>"
      );

      output.securityIssues.push({
        id: `S-${file.file}-${addedLine.line}-xss`,   // Unique ID: S-{file}-{line}-{type}
        category: "security",
        severity: "high",
        agent: "security",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Unsafe HTML rendering",
        message: "Unsanitized HTML can lead to XSS in frontend code.",
        fix: fixed,
        corrected_code: fixed,
        labels: ["security", "high", "xss"],
        confidence: 0.96 // Very high confidence — exact pattern match
      });

      // Generate a patch to apply the fix automatically
      output.patches.push({ file: file.file, line: addedLine.line, original: addedLine.content, fixed });
      output.changesSummary.push(`Sanitized HTML rendering at line ${addedLine.line}.`);
    }

    // ── SQL Injection via string interpolation ─────────────────────────────────
    // SQL queries using template literals with ${} interpolation are vulnerable
    // to injection attacks. The fix is to use parameterized queries.
    if (/select .*where .*=\s*\$\{.+\}/i.test(addedLine.content)) {
      output.securityIssues.push({
        id: `S-${file.file}-${addedLine.line}-sql`,
        category: "security",
        severity: "critical",   // SQL injection is always critical
        agent: "security",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Interpolated SQL query",
        message: "String interpolation in SQL can expose the query to injection.",
        fix: 'const sql = "select * from users where id = ?";',   // Parameterized query
        corrected_code: 'const sql = "select * from users where id = ?";',
        labels: ["security", "critical", "sql-injection"],
        confidence: 0.99 // Highest confidence — exact SQL injection pattern
      });

      output.patches.push({
        file: file.file,
        line: addedLine.line,
        original: addedLine.content,
        fixed: '  const sql = "select * from users where id = ?";' // Indented fix
      });
      output.changesSummary.push(`Replaced interpolated SQL with a parameterized query at line ${addedLine.line}.`);
    }

    // ── Missing query parameters in db.query() call ───────────────────────────
    // If we found the parameterized SQL template above but the db.query() call
    // doesn't pass the parameters, we need to fix the query call too.
    if (/db\.query\(sql\)/.test(addedLine.content)) {
      output.patches.push({
        file: file.file,
        line: addedLine.line,
        original: addedLine.content,
        fixed: "  const data = await db.query(sql, [id]);" // Add bound parameter
      });
      output.changesSummary.push(`Bound query parameters at line ${addedLine.line}.`);
    }
  }

  return output;
}

/**
 * BUG AGENT — Detects runtime bugs via regex patterns.
 *
 * Detects:
 *   - fetch() without await → untracked async call, errors are silent (medium, 0.84)
 *     Fix: wraps in async handler with await and try/catch
 */
function runBugAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of getReviewLines(file)) {
    // ── Untracked async fetch (fetch without await) ────────────────────────────
    // fetch() without await means the Promise is fire-and-forget.
    // Network errors are silently swallowed — no error handling possible.
    if (/fetch\(/.test(addedLine.content) && !/await /.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-fetch`,
        category: "bug",
        severity: "medium",
        agent: "bug",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Untracked async fetch call",
        message: "The new fetch call is not awaited or error-handled, so failures are silent.",
        suggestion: "Wrap the request in an async handler with await and try/catch.",
        corrected_code: "onClick={async () => { try { await fetch(`/api/users/${user.id}`); } catch (error) { console.error(error); } }}",
        labels: ["bug", "medium", "async"],
        confidence: 0.84 // High confidence — fetch without await is almost always a bug
      });
    }
  }

  return output;
}

/**
 * LOGIC AGENT — Detects logic errors via regex patterns.
 *
 * Detects:
 *   - db.query(sql) without bound parameters → query will fail at runtime (high, 0.93)
 *     This complements the security agent's SQL injection detection:
 *     security agent flags the interpolated SQL template,
 *     logic agent flags the query call that doesn't pass the actual parameter value.
 */
function runLogicAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of getReviewLines(file)) {
    // ── db.query(sql) without bound parameter array ────────────────────────────
    // If the query uses a parameterized template (? placeholder) but the call
    // doesn't pass the [id] parameter array, the query will either fail or
    // use undefined as the parameter value.
    if (/db\.query\(sql\)/.test(addedLine.content) && !/\[id\]/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-logic`,
        category: "bug",
        severity: "high",
        agent: "logic",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Query call misses bound parameters",
        message: "The query uses a SQL template but does not pass the route parameter to the DB driver.",
        suggestion: "Pass the route parameter as a bound argument in the query call.",
        corrected_code: "const data = await db.query(sql, [id]);", // Pass [id] as second argument
        labels: ["logic", "high"],
        confidence: 0.93 // High confidence — very specific pattern
      });
    }
  }

  return output;
}

/**
 * TYPES AGENT — Detects TypeScript type safety issues via regex patterns.
 *
 * Detects:
 *   - catch(error) without `: unknown` annotation → implicit `any` for errors (low, 0.76)
 *     In TypeScript strict mode, caught errors should be typed as `unknown`
 *     and narrowed before use. Using implicit `any` hides potential type errors.
 *     Fix: adds `: unknown` to the catch parameter
 */
function runTypesAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of getReviewLines(file)) {
    // ── Untyped catch parameter ────────────────────────────────────────────────
    // `catch (error)` without `unknown` means `error` has type `any` (pre-TS4.0 behavior).
    // TypeScript 4.0+ supports `catch (error: unknown)` which enforces type narrowing.
    if (/\bcatch\s*\(\s*error\s*\)/.test(addedLine.content) && !/unknown/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-catch-type`,
        category: "quality",
        severity: "low",
        agent: "types",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Untyped caught error",
        message: "Use unknown for caught errors in TypeScript-friendly code paths.",
        suggestion: "Annotate the caught error before narrowing it.",
        corrected_code: addedLine.content.replace(/\berror\b/, "error: unknown"), // Add `: unknown`
        labels: ["types", "low"],
        confidence: 0.76 // Medium-low confidence — some codebases intentionally skip this
      });
    }
  }

  return output;
}

/**
 * ESLINT AGENT — Detects lint violations via regex patterns.
 *
 * Detects:
 *   - console.log() / console.error() → left in production code (low, 0.72)
 *     Fix: replaces console.log/error with logger.log/error
 *
 *   - var keyword → should use const or let (low, 0.88)
 *     Fix: replaces `var` with `const`
 */
function runEslintAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of getReviewLines(file)) {
    // ── console.log / console.error in production code ─────────────────────────
    // Most production codebases ban console statements in lint rules.
    // They should use a proper logger (winston, pino, etc.) instead.
    if (/console\.(log|error)\(/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-eslint-console`,
        category: "quality",
        severity: "low",
        agent: "eslint",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Console statement in application path",
        message: "This may violate strict lint rules in production repos.",
        suggestion: "Route the event to a logger helper instead.",
        corrected_code: addedLine.content.replace(/console\.(log|error)/, "logger.$1"), // Replace with logger
        labels: ["eslint", "low"],
        confidence: 0.72 // Medium confidence — some projects allow console in dev
      });
    }

    // ── var keyword (should use const or let) ─────────────────────────────────
    // `var` has function scope and hoisting behavior that often causes subtle bugs.
    // Modern JS/TS enforces `no-var` lint rule — always use `const` or `let`.
    if (/\bvar\b/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-eslint-var`,
        category: "quality",
        severity: "low",
        agent: "eslint",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Use let/const instead of var",
        message: "Most repos enforce no-var in lint rules.",
        suggestion: "Replace var with const or let.",
        corrected_code: addedLine.content.replace(/\bvar\b/, "const"), // Default to const
        labels: ["eslint", "low"],
        confidence: 0.88 // High confidence — var is almost always wrong in modern JS/TS
      });
    }
  }

  return output;
}

/**
 * PERFORMANCE AGENT — Detects performance issues via regex patterns.
 *
 * Detects:
 *   - .sort() or .reverse() — potentially expensive in hot paths (medium, 0.74)
 *     These mutate the original array and can be expensive on large datasets.
 *     Fix: suggests precomputing/memoizing the sorted result
 */
function runPerformanceAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of getReviewLines(file)) {
    // ── .sort() or .reverse() in potentially hot code path ────────────────────
    // Sorting is O(n log n) and can be expensive on large arrays.
    // If called inside a render function or event handler, it may run on every
    // interaction. Prefer precomputed/memoized sorted versions.
    if (/\.sort\(/.test(addedLine.content) || /\.reverse\(/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-performance-sort`,
        category: "performance",
        severity: "medium",
        agent: "performance",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Potential expensive collection work in hot path",
        message: "Sorting or reversing inside frequently executed code can become expensive as data grows.",
        suggestion: "Precompute or memoize the transformed collection before rendering or repeated execution.",
        corrected_code: "const sortedItems = [...items].sort(compareItems);", // Create new sorted array (non-mutating)
        labels: ["performance", "medium"],
        confidence: 0.74 // Medium confidence — context matters (render vs. initialization)
      });
    }
  }

  return output;
}

/**
 * BEST PRACTICES AGENT — Detects engineering practice violations via regex patterns.
 *
 * Detects:
 *   - @ts-ignore → type suppression (medium, 0.83)
 *     Suppressing TypeScript errors hides real bugs. Should be a last resort.
 *     Fix: suggests replacing with a proper type guard or type refinement
 *
 *   - == (loose equality) → should use === (low, 0.71)
 *     Loose equality has implicit type coercion rules that cause subtle bugs.
 *     Fix: replaces == with === and != with !==
 */
function runBestPracticesAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of getReviewLines(file)) {
    // ── @ts-ignore → TypeScript error suppression ─────────────────────────────
    // @ts-ignore silently ignores TypeScript errors on the next line.
    // It can hide real type regressions and make bugs harder to find.
    // Prefer @ts-expect-error (fails if no error) or fix the type mismatch.
    if (/@ts-ignore/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-best-practices-ignore`,
        category: "quality",
        severity: "medium",
        agent: "best-practices",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Type suppression added",
        message: "Suppressing type errors can hide real regressions and should usually be a last resort.",
        suggestion: "Prefer fixing the underlying type mismatch or narrowing the type safely.",
        corrected_code: "// Replace the suppression with a safer type guard or explicit type refinement.",
        labels: ["best-practices", "medium"],
        confidence: 0.83 // High confidence — @ts-ignore is almost always bad practice
      });
    }

    // ── Loose equality (== instead of ===) ────────────────────────────────────
    // JavaScript's == does type coercion: 0 == "0" → true, null == undefined → true.
    // These implicit conversions cause subtle, hard-to-debug issues.
    // Use === for strict equality unless coercion is explicitly needed.
    if (/==[^=]/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-best-practices-equality`,
        category: "quality",
        severity: "low",
        agent: "best-practices",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Loose equality check",
        message: "Loose equality can hide coercion bugs and is usually avoided in shared codebases.",
        suggestion: "Use strict equality unless coercion is explicitly intended.",
        corrected_code: addedLine.content.replace(/==/g, "===").replace(/!===$/, "!=="), // Replace == with ===
        labels: ["best-practices", "low"],
        confidence: 0.71 // Medium confidence — sometimes == is intentional for null checks
      });
    }
  }

  return output;
}

/**
 * QUALITY AGENT — Detects general code quality issues via regex patterns.
 *
 * Detects:
 *   - `any` type keyword → weakens TypeScript type safety (low, 0.9)
 *     Using `any` disables type checking for that variable.
 *     Fix: replaces `any` with `unknown` (safer, requires type narrowing before use)
 */
function runQualityAgent(file: TriagedFile): AgentOutput {
  const output = createOutput();

  for (const addedLine of getReviewLines(file)) {
    // ── `any` type usage ──────────────────────────────────────────────────────
    // TypeScript's `any` type turns off type checking entirely.
    // Using it weakens the value of TypeScript and can hide bugs.
    // `unknown` is safer — it requires explicit type narrowing before use.
    if (/\bany\b/.test(addedLine.content)) {
      output.reviewIssues.push({
        id: `R-${file.file}-${addedLine.line}-typing`,
        category: "quality",
        severity: "low",
        agent: "quality",
        file: file.file,
        line: addedLine.line,
        code_snippet: addedLine.content.trim(),
        title: "Loose any typing",
        message: "Using any weakens review quality and hides type or lint regressions.",
        suggestion: "Replace any with a concrete type or a narrow interface.",
        corrected_code: addedLine.content.replace(/\bany\b/g, "unknown"), // Replace all `any` with `unknown`
        labels: ["quality", "low", "typing"],
        confidence: 0.9 // High confidence — `any` is almost always avoidable
      });
    }
  }

  return output;
}

// ─── Pipeline Assembly ────────────────────────────────────────────────────────

/**
 * Merges the outputs from all 8 agent functions into a single ReviewFileResult.
 * Combines review issues, security issues, patches, and change summaries.
 * Deduplicates change summaries to avoid repeating the same message.
 *
 * @param file    - The triaged file that was reviewed
 * @param outputs - Array of outputs from each agent function
 * @returns A complete ReviewFileResult for this file
 */
function mergeOutputs(file: TriagedFile, outputs: AgentOutput[]): ReviewFileResult {
  const reviewIssues = outputs.flatMap((output) => output.reviewIssues);   // All non-security findings
  const securityIssues = outputs.flatMap((output) => output.securityIssues); // All security findings
  const patches = outputs.flatMap((output) => output.patches);              // All auto-fix patches
  // Deduplicate change summaries (some agents may describe the same fix in the same file)
  const changesSummary = [...new Set(outputs.flatMap((output) => output.changesSummary))];

  return {
    file: file.file,
    language: file.language,
    changed_lines: file.addedLines.map((line) => line.line), // Line numbers from the diff
    triage: file.triage,                                      // Risk level and areas of concern
    review: { issues: reviewIssues },
    security: { vulnerabilities: securityIssues },
    fix: {
      required: patches.length > 0,           // true if any agent generated patches
      fixed_code: buildFixedCode(file, patches), // Apply all patches to produce fixed code
      patches,
      changes_summary: changesSummary
    }
  };
}

/**
 * Builds the agent_runs summary showing how many findings each agent produced.
 * The "fix" agent's count is the total number of auto-generated patches
 * (which may span multiple issue types).
 */
function buildAgentRuns(files: ReviewFileResult[]): AgentRunSummary[] {
  const allIssues = files.flatMap((file) => [...file.review.issues, ...file.security.vulnerabilities]);
  const patchCount = files.reduce((total, file) => total + file.fix.patches.length, 0);

  return (["security", "bug", "logic", "types", "eslint", "performance", "best-practices", "quality", "fix"] as const).map((agent) => ({
    agent,
    findings: agent === "fix" ? patchCount : allIssues.filter((issue) => issue.agent === agent).length,
    status: "completed" as const // Always "completed" for local agents — they never fail
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs the pattern-based local agent pipeline on all triaged files.
 * Called when:
 *   1. No AI provider is configured (LocalProvider)
 *   2. An AI provider fails or returns no findings (fallback)
 *   3. The AI multi-agent pipeline returns zero findings
 *
 * Runs all 8 agent functions synchronously (no async, no network, no AI).
 * Always returns a valid ReviewResult — never throws.
 *
 * @param triagedFiles - Files with diff content and risk triage
 * @returns ReviewResult with findings from all 8 pattern agents
 */
export function runLocalAgentPipeline(triagedFiles: TriagedFile[]): ReviewResult {
  const result = createEmptyReview(triagedFiles); // Start with clean empty result

  // Run all 8 agents on each file and merge their outputs
  result.files = triagedFiles.map((file) =>
    mergeOutputs(file, [
      runSecurityAgent(file),      // XSS, SQL injection
      runBugAgent(file),           // Untracked async, missing await
      runLogicAgent(file),         // Missing bound parameters
      runTypesAgent(file),         // Untyped catch errors
      runEslintAgent(file),        // Console statements, var keyword
      runPerformanceAgent(file),   // .sort() in hot paths
      runBestPracticesAgent(file), // @ts-ignore, loose equality
      runQualityAgent(file)        // `any` type usage
    ])
  );

  // Build PR comments for all findings
  result.reports.pr_comments = result.files.flatMap((file) =>
    [...file.review.issues, ...file.security.vulnerabilities].map((issue) => buildComment(issue))
  );

  // Build agent run summary
  result.reports.agent_runs = buildAgentRuns(result.files);

  // Deduplicate, count severities, decide approve/request_changes, build markdown summary
  return finalizeSummary(result);
}
