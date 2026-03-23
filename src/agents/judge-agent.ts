/**
 * ============================================================
 * FILE: src/agents/judge-agent.ts
 * PURPOSE: The Judge Agent — QA supervisor that runs after all 8 agents.
 *
 * SIX TASKS (run in this order):
 *
 *   TASK 0 — GROUP (first, most important for UX)
 *     When multiple findings share the same root cause at different lines
 *     (e.g., 4× "Loose any typing" at lines 7, 10, 27, 32), consolidate
 *     them into ONE entry that lists all line numbers. The developer sees
 *     ONE issue with all locations — not 4 identical reports.
 *     Grouping criteria: same agent + same problem type + same pattern.
 *
 *   TASK 1 — VALIDATE
 *     For each remaining individual finding: keep=true (real) or keep=false (false positive).
 *
 *   TASK 2 — DEDUPLICATE
 *     If two agents reported the same issue at the same line, keep the better one.
 *
 *   TASK 3 — GAP DETECTION
 *     Re-read the full file. Name and describe every issue no agent caught.
 *
 *   TASK 4 — SCORE AGENTS
 *     Rate each agent 0–1. Below 0.5 → flag for retry.
 *
 *   TASK 5 — RETRY
 *     List agents that should re-run with gap-targeted prompts.
 *
 * PIPELINE INTEGRATION (in ai-agents.ts):
 *   8 agents parallel → runJudgePipeline → finalizeSummary
 * ============================================================
 */

import type {
  AgentName,
  IssueCategory,
  JudgeAgentScore,
  JudgeConsolidatedGroup,
  JudgeFindingDecision,
  JudgeGap,
  JudgeVerdict,
  ReviewFileResult,
  ReviewIssue,
  SecurityIssue,
  Severity,
  TriagedFile
} from "../types.js";
import { callAI } from "../utils/ai-call.js";
import { safeJsonParse } from "../utils/json.js";

// ─── Internal AI Response Types ───────────────────────────────────────────────

interface JudgeAIResponse {
  groups:       JudgeConsolidatedGroup[];
  decisions:    JudgeFindingDecision[];
  gaps:         JudgeGap[];
  agent_scores: JudgeAgentScore[];
  retry_agents: Exclude<AgentName, "fix">[];
  summary:      string;
}

interface FindingSummary {
  id:           string;
  agent:        string;
  line:         number;
  severity:     string;
  title:        string;
  message:      string;
  code_snippet: string;
}

// ─── Agent Scope (for judge context) ─────────────────────────────────────────

const AGENT_SCOPE: Record<string, string> = {
  security:         "secrets/tokens, XSS, unsafe HTML, injections, credential leaks",
  bug:              "crashes, null deref, async bugs, infinite loops, state mutation",
  logic:            "assignment-in-condition, loose equality, always-true conditions",
  types:            "props:any, useState<any>, event handlers as any, missing return types",
  performance:      "heavy loops in render, Math.random() in JSX, missing useMemo/useCallback",
  eslint:           "console.log in code, unused vars, useless onClick, missing hook deps",
  "best-practices": "hardcoded credentials/URLs, auth in UI, missing error handling",
  quality:          "side effects in render body, useEffect without deps, unstable keys"
};

// ─── Context Builder ──────────────────────────────────────────────────────────

function buildJudgeContext(file: TriagedFile, fileResult: ReviewFileResult): string {
  const allFindings: FindingSummary[] = [
    ...fileResult.security.vulnerabilities,
    ...fileResult.review.issues
  ].map((issue) => ({
    id:           issue.id,
    agent:        issue.agent,
    line:         issue.line,
    severity:     issue.severity,
    title:        issue.title,
    message:      issue.message,
    code_snippet: issue.code_snippet
  }));

  // Coverage summary: how many findings each agent produced
  const agentCoverage = Object.entries(AGENT_SCOPE).map(([agent, scope]) => {
    const found = allFindings.filter((f) => f.agent === agent);
    const ids   = found.length > 0 ? ` — IDs: ${found.map((f) => f.id).join(", ")}` : " — NONE";
    return `  ${agent} (${scope}): ${found.length} finding${found.length !== 1 ? "s" : ""}${ids}`;
  }).join("\n");

  const fullFileLines = (file.fullFileLines?.length ? file.fullFileLines : file.contextLines)
    .map((line) => `${line.line}: ${line.content}`)
    .join("\n");

  return [
    `File: ${file.file}`,
    `Language: ${file.language}`,
    `Risk level: ${file.triage.risk_level}`,
    "",
    `AGENT COVERAGE (${allFindings.length} total findings):`,
    agentCoverage,
    "",
    `ALL FINDINGS (${allFindings.length} total — use IDs in your response):`,
    JSON.stringify(allFindings, null, 2),
    "",
    "FULL FILE CONTENT (re-read independently for gap detection and grouping):",
    fullFileLines || "(unavailable)"
  ].join("\n");
}

// ─── Judge System Prompt ──────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are the Judge Agent — the final quality authority on all PR review findings.

8 specialized agents have reviewed a file. You have their findings and the original source code.
Run these 6 tasks IN ORDER and produce a single JSON response.

════════════════════════════════════════════════════════════
TASK 0 — GROUP SIMILAR FINDINGS  ← DO THIS FIRST
════════════════════════════════════════════════════════════
Before anything else: look for findings that are the SAME PROBLEM repeating at multiple lines.
These should become ONE group entry instead of many separate reports.

Group when:
  - Same agent AND same problem type (e.g., multiple "any" typings, multiple console.logs,
    multiple hardcoded values, multiple useState<any>, multiple missing awaits)
  - The pattern is identical — only the line number differs
  - There are 2 or more such findings

For each group:
  - List all IDs being merged in "ids" array
  - Set "lines" to ALL affected line numbers
  - Write the title ONCE: e.g. "Multiple \`any\` type usages · 4 locations"
  - Write the issue description ONCE (shared explanation)
  - Write ONE representative fix showing the pattern to apply everywhere
  - Set severity to the HIGHEST severity among grouped findings
  - These IDs must NOT appear in "decisions" (they are replaced by the group)

════════════════════════════════════════════════════════════
TASK 1 — VALIDATE individual findings (not in any group)
════════════════════════════════════════════════════════════
For each finding NOT already grouped, set keep=true (real issue) or keep=false (false positive).
Write a short reason for every decision.

════════════════════════════════════════════════════════════
TASK 2 — DEDUPLICATE
════════════════════════════════════════════════════════════
If two separate findings describe the same issue at the same line:
  Keep the better one (more specific, higher severity, has fix code).
  Set duplicate_of on the weaker one and keep=false.

════════════════════════════════════════════════════════════
TASK 3 — DETECT GAPS
════════════════════════════════════════════════════════════
Re-read the file carefully. What real issues exist that NO agent reported?
For each gap: name the responsible agent, describe exactly what was missed, cite the line.
Do not invent issues — only real problems visible in the code.

════════════════════════════════════════════════════════════
TASK 4 — SCORE AGENTS (0.0 to 1.0)
════════════════════════════════════════════════════════════
For each of the 8 agents: how well did it cover its domain?
1.0 = found everything relevant
0.5 = found some but missed obvious issues
0.0 = found nothing in its domain (when issues clearly exist)
needs_retry=true if score < 0.5 OR if it missed a critical/high issue.

════════════════════════════════════════════════════════════
TASK 5 — RETRY LIST
════════════════════════════════════════════════════════════
List only agents that genuinely underperformed. Do not retry agents that found nothing
because the code is actually clean in their domain.

Return ONLY valid JSON — no markdown, no prose outside the JSON:
{
  "groups": [
    {
      "ids": ["R-ai-types-file-7", "R-ai-types-file-10", "R-ai-quality-file-27"],
      "agent": "types",
      "category": "quality",
      "severity": "medium",
      "title": "Multiple \`any\` type usages · 3 locations",
      "issue": "Using any defeats TypeScript type checking and hides bugs. Found in component props, useState, and event handlers.",
      "lines": [7, 10, 27],
      "fix": "Define interfaces:\\ninterface FormData { email: string; pass: string }\\nconst [data, setData] = useState<FormData>({ email: '', pass: '' })\\nconst update = (e: React.ChangeEvent<HTMLInputElement>) => {...}",
      "confidence": 0.95
    }
  ],
  "decisions": [
    {"id": "R-ai-bug-file-42", "keep": true, "reason": "real infinite loop"},
    {"id": "R-ai-eslint-file-18", "keep": false, "reason": "false positive — value IS used on line 25"}
  ],
  "gaps": [
    {"agent": "performance", "missed": "heavy() called directly in JSX — runs on every render", "line": 80, "severity": "high"}
  ],
  "agent_scores": [
    {"agent": "types", "score": 0.9, "needs_retry": false, "gaps": []},
    {"agent": "performance", "score": 0.3, "needs_retry": true, "gaps": ["missed heavy() in JSX"]}
  ],
  "retry_agents": ["performance"],
  "summary": "Grouped 3 any-typing issues. Performance underperformed — retrying."
}`;

// ─── Judge Runner ─────────────────────────────────────────────────────────────

async function runJudge(file: TriagedFile, fileResult: ReviewFileResult): Promise<JudgeVerdict | null> {
  const allFindings = [
    ...fileResult.security.vulnerabilities,
    ...fileResult.review.issues
  ];

  if (allFindings.length === 0) return null;

  const context = buildJudgeContext(file, fileResult);
  const text    = await callAI(JUDGE_SYSTEM, context, 2400);
  if (!text) return null;

  const parsed = safeJsonParse<JudgeAIResponse | null>(text, null);
  if (!parsed) return null;

  return {
    groups:       parsed.groups       ?? [],
    decisions:    parsed.decisions    ?? [],
    gaps:         parsed.gaps         ?? [],
    agent_scores: parsed.agent_scores ?? [],
    retry_agents: parsed.retry_agents ?? [],
    summary:      parsed.summary      ?? ""
  };
}

// ─── Apply Groups ─────────────────────────────────────────────────────────────

/**
 * Applies the judge's grouping decisions to a file result.
 *
 * For each group:
 *   1. Remove all individual findings listed in `group.ids`
 *   2. Add ONE consolidated ReviewIssue in their place:
 *        - title:   "Multiple `any` type usages · 4 locations"
 *        - message: shared description + "Affected lines: 7, 10, 27, 32"
 *        - line:    first line in the group (used for inline comment placement)
 *        - labels:  includes all line numbers encoded as "lines:7,10,27,32"
 */
function applyGroups(fileResult: ReviewFileResult, groups: JudgeConsolidatedGroup[]): void {
  if (groups.length === 0) return;

  for (const group of groups) {
    const groupedIds = new Set(group.ids);

    // Remove the individual findings that are being consolidated
    fileResult.review.issues = fileResult.review.issues.filter(
      (issue) => !groupedIds.has(issue.id)
    );
    fileResult.security.vulnerabilities = fileResult.security.vulnerabilities.filter(
      (issue) => !groupedIds.has(issue.id)
    );

    // Build the consolidated message with all line locations listed
    const lineList = group.lines
      .sort((a, b) => a - b)
      .join(", ");

    const consolidatedMessage = [
      group.issue,
      "",
      `Affected lines: ${lineList}`
    ].join("\n");

    // Create ONE consolidated finding
    const consolidated: ReviewIssue = {
      id:            `C-judge-${group.agent}-${fileResult.file}-${group.lines[0]}`,
      category:      group.category as IssueCategory,
      severity:      group.severity,
      agent:         group.agent,
      file:          fileResult.file,
      line:          group.lines[0] ?? 0,               // Primary line for inline placement
      code_snippet:  "",                                  // No single snippet — it's a pattern
      title:         group.title,
      message:       consolidatedMessage,
      suggestion:    group.fix,
      corrected_code: group.fix,
      labels:        [
        group.agent,
        group.severity,
        "grouped",
        `lines:${lineList}`                              // All line numbers encoded in labels
      ],
      confidence:    group.confidence ?? 0.9
    };

    // Security category → goes to vulnerabilities, not review.issues
    if (group.category === "security") {
      fileResult.security.vulnerabilities.push({
        id:            consolidated.id,
        category:      "security",
        severity:      consolidated.severity,
        agent:         "security",
        file:          consolidated.file,
        line:          consolidated.line,
        code_snippet:  "",
        title:         consolidated.title,
        message:       consolidated.message,
        fix:           group.fix,
        corrected_code: group.fix,
        labels:        consolidated.labels,
        confidence:    consolidated.confidence
      });
    } else {
      fileResult.review.issues.push(consolidated);
    }
  }
}

// ─── Apply Decisions (validate + deduplicate) ─────────────────────────────────

function applyJudgeDecisions(fileResult: ReviewFileResult, verdict: JudgeVerdict): void {
  // Build set of IDs to remove: keep=false OR duplicate_of is set
  const dismissedIds = new Set<string>();
  for (const decision of verdict.decisions) {
    if (!decision.keep || decision.duplicate_of) {
      dismissedIds.add(decision.id);
    }
  }

  if (dismissedIds.size === 0) return;

  fileResult.review.issues = fileResult.review.issues.filter(
    (issue) => !dismissedIds.has(issue.id)
  );
  fileResult.security.vulnerabilities = fileResult.security.vulnerabilities.filter(
    (issue) => !dismissedIds.has(issue.id)
  );
}

// ─── Retry Agent Runner ────────────────────────────────────────────────────────

/** Minimal agent spec needed for retrying — passed in from ai-agents.ts */
export interface AgentSpecForRetry {
  agent:      Exclude<AgentName, "fix">;
  category:   "security" | "bug" | "performance" | "quality";
  system:     string;
  maxTokens:  number;
  confidence: number;
}

interface AIRetryIssue {
  line?:         number;
  title?:        string;
  message?:      string;
  severity?:     string;
  confidence?:   number;
  code_snippet?: string;
  suggestion?:   string;
  fix?:          string;
}

/**
 * Re-runs a specific agent with an enhanced prompt that explicitly names
 * the gaps the judge identified. This focuses the second pass on exactly
 * what was missed rather than repeating the full review.
 */
async function retryOneAgent(
  agentName:  Exclude<AgentName, "fix">,
  file:       TriagedFile,
  gaps:       JudgeGap[],
  agentSpecs: AgentSpecForRetry[]
): Promise<{ review: ReviewIssue[]; security: SecurityIssue[] }> {
  const spec = agentSpecs.find((s) => s.agent === agentName);
  if (!spec) return { review: [], security: [] };

  const agentGaps = gaps.filter((g) => g.agent === agentName);
  if (agentGaps.length === 0) return { review: [], security: [] };

  const gapText = agentGaps
    .map((g) => `- Line ${g.line ?? "?"}: ${g.missed} [${g.severity}]`)
    .join("\n");

  const retryAddendum = `

JUDGE RETRY — SECOND PASS:
The judge reviewed your previous output and found these specific issues you missed:
${gapText}

Re-examine the file and report these specific missed issues. Do not repeat issues you already found.`;

  const enhancedSystem = spec.system + retryAddendum;

  const fullFileLines = (file.fullFileLines?.length ? file.fullFileLines : file.contextLines)
    .map((line) => `${line.line}: ${line.content}`)
    .join("\n");

  const context = [
    `File: ${file.file}`,
    `Language: ${file.language}`,
    "",
    "Full file content:",
    fullFileLines
  ].join("\n");

  const text = await callAI(enhancedSystem, context, spec.maxTokens);
  if (!text) return { review: [], security: [] };

  const parsed = safeJsonParse<{ issues: AIRetryIssue[] } | null>(text, null);
  if (!parsed?.issues?.length) return { review: [], security: [] };

  if (agentName === "security") {
    return {
      review: [],
      security: parsed.issues.map((issue) => ({
        id:            `S-retry-${file.file}-${issue.line}-security`,
        category:      "security" as const,
        severity:      (issue.severity ?? "medium") as Severity,
        agent:         "security" as const,
        file:          file.file,
        line:          issue.line ?? 0,
        code_snippet:  issue.code_snippet ?? "",
        title:         issue.title ?? "Security issue",
        message:       issue.message ?? "",
        fix:           issue.fix ?? issue.suggestion ?? "",
        corrected_code: issue.fix ?? issue.suggestion,
        labels:        ["security", issue.severity ?? "medium", "retried"],
        confidence:    typeof issue.confidence === "number" ? issue.confidence : spec.confidence
      }))
    };
  }

  return {
    security: [],
    review: parsed.issues.map((issue) => ({
      id:            `R-retry-${agentName}-${file.file}-${issue.line}`,
      category:      spec.category,
      severity:      (issue.severity ?? "medium") as Severity,
      agent:         agentName,
      file:          file.file,
      line:          issue.line ?? 0,
      code_snippet:  issue.code_snippet ?? "",
      title:         issue.title ?? "Issue",
      message:       issue.message ?? "",
      suggestion:    issue.suggestion ?? issue.fix ?? "",
      corrected_code: issue.fix,
      labels:        [agentName, issue.severity ?? "medium", "retried"],
      confidence:    typeof issue.confidence === "number" ? issue.confidence : spec.confidence
    }))
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs the judge pipeline on all file results.
 *
 * Per file:
 *   1. Run judge → JudgeVerdict (groups + decisions + gaps + scores + retries)
 *   2. Apply groups → replace N similar findings with 1 consolidated entry
 *   3. Apply decisions → remove false positives and duplicates
 *   4. Log judge summary to CI console
 *   5. Retry underperforming agents → merge new findings
 *
 * Returns mutated fileResults (same array). If judge AI fails → unchanged.
 */
export async function runJudgePipeline(
  fileResults:  ReviewFileResult[],
  triagedFiles: TriagedFile[],
  agentSpecs:   AgentSpecForRetry[]
): Promise<ReviewFileResult[]> {

  for (const fileResult of fileResults) {
    const triagedFile = triagedFiles.find((f) => f.file === fileResult.file);
    if (!triagedFile) continue;

    // ── 1. Run judge ─────────────────────────────────────────────────────────
    const verdict = await runJudge(triagedFile, fileResult);
    if (!verdict) continue;   // Judge failed — keep all agent findings as-is

    // ── 2. Apply groups (FIRST — before decisions remove grouped IDs) ────────
    applyGroups(fileResult, verdict.groups);

    // ── 3. Apply decisions (validate + deduplicate) ──────────────────────────
    applyJudgeDecisions(fileResult, verdict);

    // ── 4. Log to CI console ─────────────────────────────────────────────────
    if (verdict.summary) {
      console.log(`[Judge] ${fileResult.file}: ${verdict.summary}`);
    }
    if (verdict.groups.length > 0) {
      const groupLog = verdict.groups
        .map((g) => `  grouped ${g.ids.length}× "${g.title}"`)
        .join("\n");
      console.log(`[Judge] Grouped findings:\n${groupLog}`);
    }
    if (verdict.agent_scores.length > 0) {
      const scoreLog = verdict.agent_scores
        .map((s) => `${s.agent}=${(s.score * 100).toFixed(0)}%${s.needs_retry ? " ⚠️" : ""}`)
        .join(" | ");
      console.log(`[Judge] Scores: ${scoreLog}`);
    }
    if (verdict.retry_agents.length > 0) {
      console.log(`[Judge] Retrying: ${verdict.retry_agents.join(", ")}`);
    }

    // ── 5. Retry underperforming agents ──────────────────────────────────────
    if (verdict.retry_agents.length > 0 && verdict.gaps.length > 0) {
      const retryResults = await Promise.all(
        verdict.retry_agents.map((agentName) =>
          retryOneAgent(agentName, triagedFile, verdict.gaps, agentSpecs)
        )
      );

      for (const retried of retryResults) {
        fileResult.review.issues.push(...retried.review);
        fileResult.security.vulnerabilities.push(...retried.security);
      }

      // Rebuild patches from any new retry finding that has a fix
      const newPatchable = retryResults.flatMap((r) => [
        ...r.review.filter((i) => i.corrected_code),
        ...r.security.filter((i) => i.corrected_code)
      ]);
      for (const issue of newPatchable) {
        fileResult.fix.patches.push({
          file:     issue.file,
          line:     issue.line,
          original: issue.code_snippet,
          fixed:    issue.corrected_code as string
        });
      }
      fileResult.fix.required = fileResult.fix.patches.length > 0;
    }
  }

  return fileResults;
}
