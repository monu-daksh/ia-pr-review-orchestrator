/**
 * ============================================================
 * FILE: src/agents/judge-agent.ts
 * PURPOSE: The Judge Agent — a QA supervisor that runs after all 8
 *          specialized agents have produced their findings.
 *
 * WHAT THE JUDGE DOES (5 tasks, in order):
 *
 *   TASK 1 — VALIDATE
 *     For each finding (by ID), decide: real issue (keep=true) or
 *     false positive / out-of-scope (keep=false). Dismissed findings
 *     are removed from the final output.
 *
 *   TASK 2 — DEDUPLICATE
 *     If two agents reported the same issue at the same location,
 *     keep the higher-quality finding and mark the other as
 *     `duplicate_of: <winning-id>`. The duplicate is removed.
 *
 *   TASK 3 — GAP DETECTION
 *     The judge re-reads the full file independently. For every real
 *     issue it finds that NO agent reported, it records a JudgeGap
 *     naming the responsible agent and describing what was missed.
 *
 *   TASK 4 — AGENT SCORING
 *     Each agent gets a score 0.0–1.0 based on how well it covered its
 *     domain. An agent that missed obvious issues scores low.
 *
 *   TASK 5 — RETRY
 *     Agents with score < 0.5 or that missed critical/high issues are
 *     flagged for re-run. The retry uses an enhanced prompt that tells
 *     the agent exactly what it missed so it can focus its second pass.
 *
 * PIPELINE INTEGRATION:
 *   runAIAgentPipeline (ai-agents.ts)
 *     → 8 agents run in parallel  → fileResults
 *     → runJudgePipeline(fileResults, triagedFiles)
 *         → per-file: runJudge() → JudgeVerdict
 *         → applyJudgeDecisions() → filtered fileResult
 *         → retryUnderperformingAgents() → additional findings merged in
 *     → finalizeSummary()
 * ============================================================
 */

import type {
  AgentName,
  JudgeAgentScore,
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

/** Shape of the JSON the judge AI returns */
interface JudgeAIResponse {
  decisions:    JudgeFindingDecision[];
  gaps:         JudgeGap[];
  agent_scores: JudgeAgentScore[];
  retry_agents: Exclude<AgentName, "fix">[];
  summary:      string;
}

/** Shape of a single finding summary sent to the judge (compact, not full issue) */
interface FindingSummary {
  id:           string;
  agent:        string;
  line:         number;
  severity:     string;
  title:        string;
  message:      string;
  code_snippet: string;
}

// ─── Agent Scope Descriptions (for judge context) ─────────────────────────────

/**
 * Maps each agent to a one-line description of its responsibility.
 * The judge uses this to assess whether each agent covered its domain.
 */
const AGENT_SCOPE: Record<string, string> = {
  security:         "secrets/tokens, XSS, unsafe HTML, injections, open redirects, credential leaks",
  bug:              "crashes, null dereference, async bugs, infinite loops, state mutation, missing cleanup",
  logic:            "assignment-in-condition, loose equality, always-true/false conditions, validation fall-through",
  types:            "props:any, useState<any>, event handlers typed as any, missing return types",
  performance:      "heavy loops in render/JSX, Math.random() in JSX, missing useMemo/useCallback, Date.now() in JSX",
  eslint:           "console.log left in code, unused variables/imports, useless onClick handlers, missing hook deps",
  "best-practices": "hardcoded credentials/URLs, auth logic in UI, missing error handling, component doing too many jobs",
  quality:          "side effects in render body, useEffect without deps array, missing loading/error states, unstable keys"
};

// ─── Context Builders ─────────────────────────────────────────────────────────

/**
 * Builds the context string sent to the judge.
 * Contains two sections:
 *   1. Agent findings — every finding from all agents in a compact JSON list
 *   2. Full file content — the actual code the judge re-reads to spot gaps
 */
function buildJudgeContext(file: TriagedFile, fileResult: ReviewFileResult): string {
  // Flatten all findings from all agents into one compact list
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

  // Group finding IDs by agent so the judge can see coverage at a glance
  const agentCoverage = Object.entries(AGENT_SCOPE).map(([agent, scope]) => {
    const found = allFindings.filter((f) => f.agent === agent);
    return `  ${agent} (scope: ${scope}): ${found.length} finding${found.length !== 1 ? "s" : ""}${found.length > 0 ? ` — IDs: ${found.map(f => f.id).join(", ")}` : " — NONE"}`;
  }).join("\n");

  const fullFileLines = (file.fullFileLines?.length ? file.fullFileLines : file.contextLines)
    .map((line) => `${line.line}: ${line.content}`)
    .join("\n");

  return [
    `File: ${file.file}`,
    `Language: ${file.language}`,
    `Risk level: ${file.triage.risk_level}`,
    "",
    `AGENT COVERAGE SUMMARY (${allFindings.length} total findings):`,
    agentCoverage,
    "",
    `ALL FINDINGS FROM ALL AGENTS (${allFindings.length} total):`,
    JSON.stringify(allFindings, null, 2),
    "",
    "FULL FILE CONTENT (re-read this independently to detect gaps and validate findings):",
    fullFileLines || "(file content unavailable)"
  ].join("\n");
}

// ─── Judge System Prompt ──────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are the Judge Agent — the final authority on PR code review quality.

8 specialized agents have reviewed a file. You receive all their findings and the original file content.
Your job is to quality-control their output and identify anything they missed.

TASK 1 — VALIDATE each finding (by ID):
  - keep=true  → real issue, well-scoped, accurate
  - keep=false → false positive, irrelevant, or wrong line
  Write a short reason for every decision.

TASK 2 — DEDUPLICATE:
  If two findings describe the same issue at the same location, keep the better one.
  Set duplicate_of to the ID of the finding you are keeping (and set keep=false on the duplicate).

TASK 3 — DETECT GAPS (most important task):
  Re-read the full file content carefully. For every real issue that EXISTS in the code
  but NO agent reported, add a JudgeGap entry. Name the agent who SHOULD have caught it.
  Be specific: cite the line number, the exact code, and why it's an issue.
  Do not invent issues — only report real problems visible in the code.

TASK 4 — SCORE each agent 0.0 to 1.0:
  1.0 = found everything in its domain
  0.5 = found some but missed obvious issues
  0.0 = found nothing relevant, completely missed its domain
  Score below 0.5 → needs_retry=true.
  If an agent missed a critical or high severity issue → needs_retry=true regardless of score.

TASK 5 — RETRY LIST:
  List agents that should re-run in retry_agents.
  Only include agents that genuinely underperformed (not agents that found nothing because the code is clean).

Return ONLY valid JSON — no markdown, no prose:
{
  "decisions": [
    {"id": "R-ai-bug-file-42", "keep": true, "reason": "valid infinite loop"},
    {"id": "R-ai-eslint-file-18", "keep": false, "reason": "false positive — value IS used on line 25"}
  ],
  "gaps": [
    {"agent": "performance", "missed": "heavy() called directly in JSX — runs on every render", "line": 80, "severity": "high"},
    {"agent": "logic", "missed": "if(user.password = 'admin') uses = (assignment) not == — always true", "line": 49, "severity": "critical"}
  ],
  "agent_scores": [
    {"agent": "security", "score": 0.9, "needs_retry": false, "gaps": []},
    {"agent": "performance", "score": 0.3, "needs_retry": true, "gaps": ["missed heavy() in JSX render", "missed Math.random() in className"]}
  ],
  "retry_agents": ["performance", "logic"],
  "summary": "Security strong. Performance and logic underperformed — retrying both."
}`;

// ─── Judge Runner ─────────────────────────────────────────────────────────────

/**
 * Runs the Judge Agent on a single file's results.
 * Returns a JudgeVerdict or null if the AI call fails.
 *
 * Failure handling: if judge fails (AI unavailable, bad JSON), the pipeline
 * continues without judge validation — all agent findings pass through as-is.
 * This ensures the judge is additive, never a blocker.
 */
async function runJudge(file: TriagedFile, fileResult: ReviewFileResult): Promise<JudgeVerdict | null> {
  const allFindings = [
    ...fileResult.security.vulnerabilities,
    ...fileResult.review.issues
  ];

  // Skip judge if no agents found anything — nothing to judge
  if (allFindings.length === 0) return null;

  const context = buildJudgeContext(file, fileResult);

  // Judge gets more tokens because it processes the full findings list + code
  const text = await callAI(JUDGE_SYSTEM, context, 2000);
  if (!text) return null;

  const parsed = safeJsonParse<JudgeAIResponse | null>(text, null);
  if (!parsed) return null;

  return {
    decisions:    parsed.decisions    ?? [],
    gaps:         parsed.gaps         ?? [],
    agent_scores: parsed.agent_scores ?? [],
    retry_agents: parsed.retry_agents ?? [],
    summary:      parsed.summary      ?? ""
  };
}

// ─── Verdict Application ──────────────────────────────────────────────────────

/**
 * Applies the judge's decisions to a file result in-place.
 *
 * For each finding:
 *   - If verdict says keep=false → remove it
 *   - If verdict says duplicate_of → remove it (the other one stays)
 * Findings with no decision from the judge are kept (benefit of the doubt).
 */
function applyJudgeDecisions(fileResult: ReviewFileResult, verdict: JudgeVerdict): void {
  // Build a set of IDs to remove
  const dismissedIds = new Set<string>();
  for (const decision of verdict.decisions) {
    if (!decision.keep || decision.duplicate_of) {
      dismissedIds.add(decision.id);
    }
  }

  if (dismissedIds.size === 0) return; // Nothing to remove

  fileResult.review.issues = fileResult.review.issues.filter(
    (issue) => !dismissedIds.has(issue.id)
  );
  fileResult.security.vulnerabilities = fileResult.security.vulnerabilities.filter(
    (issue) => !dismissedIds.has(issue.id)
  );
}

// ─── Retry Agent Runner ────────────────────────────────────────────────────────

/**
 * Re-runs a specific agent with an enhanced prompt that tells it exactly
 * what the judge identified as a gap in its previous output.
 *
 * The enhanced prompt:
 *   [original agent system prompt]
 *   + gap-aware addendum: "The judge identified these specific missed issues: ..."
 *
 * This focuses the agent's second pass on what it initially missed.
 */
async function retryOneAgent(
  agentName: Exclude<AgentName, "fix">,
  file: TriagedFile,
  gaps: JudgeGap[],
  agentSpecs: AgentSpecForRetry[]
): Promise<{ review: ReviewIssue[]; security: SecurityIssue[] }> {
  const spec = agentSpecs.find((s) => s.agent === agentName);
  if (!spec) return { review: [], security: [] };

  // Build the gap-aware addendum
  const agentGaps = gaps.filter((g) => g.agent === agentName);
  if (agentGaps.length === 0) return { review: [], security: [] };

  const gapText = agentGaps
    .map((g) => `- Line ${g.line ?? "?"}: ${g.missed} [${g.severity}]`)
    .join("\n");

  const retryAddendum = `

JUDGE RETRY — SECOND PASS:
The judge reviewed your previous output and identified these specific gaps you missed:
${gapText}

Please re-examine the full file content and specifically look for the issues listed above.
Report each one you confirm as a real issue. Do not repeat findings you already reported.`;

  const enhancedSystem = spec.system + retryAddendum;

  const fullFileLines = (file.fullFileLines?.length ? file.fullFileLines : file.contextLines)
    .map((line) => `${line.line}: ${line.content}`)
    .join("\n");

  const context = [
    `File: ${file.file}`,
    `Language: ${file.language}`,
    "",
    "Current full file content:",
    fullFileLines
  ].join("\n");

  const text = await callAI(enhancedSystem, context, spec.maxTokens);
  if (!text) return { review: [], security: [] };

  const parsed = safeJsonParse<{ issues: AIRetryIssue[] } | null>(text, null);
  if (!parsed?.issues?.length) return { review: [], security: [] };

  // Map retry findings back to ReviewIssue / SecurityIssue with retry-tagged IDs
  if (agentName === "security") {
    const security: SecurityIssue[] = parsed.issues.map((issue) => ({
      id:           `S-retry-${file.file}-${issue.line}-security`,
      category:     "security" as const,
      severity:     (issue.severity ?? "medium") as Severity,
      agent:        "security" as const,
      file:         file.file,
      line:         issue.line ?? 0,
      code_snippet: issue.code_snippet ?? "",
      title:        issue.title ?? "Security issue",
      message:      issue.message ?? "",
      fix:          issue.fix ?? issue.suggestion ?? "",
      corrected_code: issue.fix ?? issue.suggestion,
      labels:       ["security", issue.severity ?? "medium", "retried"],
      confidence:   typeof issue.confidence === "number" ? issue.confidence : spec.confidence
    }));
    return { review: [], security };
  }

  const review: ReviewIssue[] = parsed.issues.map((issue) => ({
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
  }));
  return { review, security: [] };
}

// ─── Internal Types for Retry ─────────────────────────────────────────────────

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

// ─── Main Public API ──────────────────────────────────────────────────────────

/**
 * Runs the complete judge pipeline on all file results.
 *
 * For each file:
 *   1. Run judge → get verdict (validate / deduplicate / detect gaps / score / retry list)
 *   2. Apply verdict → remove false positives and duplicates
 *   3. For each underperforming agent → re-run with gap-aware prompt
 *   4. Merge retry findings back into the file result
 *
 * Returns the improved file results (same array, mutated in-place).
 * If judge AI is unavailable, returns file results unchanged.
 *
 * @param fileResults  - Raw results from the 8 parallel agents
 * @param triagedFiles - Original triaged files (for full file content in retry)
 * @param agentSpecs   - Agent configurations needed to run retries
 * @returns            - Improved file results after judge QA
 */
export async function runJudgePipeline(
  fileResults:  ReviewFileResult[],
  triagedFiles: TriagedFile[],
  agentSpecs:   AgentSpecForRetry[]
): Promise<ReviewFileResult[]> {

  for (let i = 0; i < fileResults.length; i++) {
    const fileResult = fileResults[i];
    const triagedFile = triagedFiles.find((f) => f.file === fileResult.file);
    if (!triagedFile) continue;

    // ── Step 1: Run judge ────────────────────────────────────────────────────
    const verdict = await runJudge(triagedFile, fileResult);

    // If judge failed (no AI, bad response) → skip, keep all agent findings
    if (!verdict) continue;

    // ── Step 2: Apply decisions (remove false positives + duplicates) ────────
    applyJudgeDecisions(fileResult, verdict);

    // ── Step 3: Log judge summary to console (visible in CI logs) ───────────
    if (verdict.summary) {
      const agentScoreSummary = verdict.agent_scores
        .map((s) => `${s.agent}=${(s.score * 100).toFixed(0)}%${s.needs_retry ? " ⚠️ retry" : ""}`)
        .join(" | ");
      console.log(`[Judge] ${fileResult.file}: ${verdict.summary}`);
      if (agentScoreSummary) console.log(`[Judge] Scores: ${agentScoreSummary}`);
      if (verdict.retry_agents.length > 0) {
        console.log(`[Judge] Retrying agents: ${verdict.retry_agents.join(", ")}`);
      }
    }

    // ── Step 4: Retry underperforming agents ──────────────────────────────────
    if (verdict.retry_agents.length > 0 && verdict.gaps.length > 0) {
      const retryResults = await Promise.all(
        verdict.retry_agents.map((agentName) =>
          retryOneAgent(agentName, triagedFile, verdict.gaps, agentSpecs)
        )
      );

      // Merge retry findings back into the file result
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
