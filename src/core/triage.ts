/**
 * ============================================================
 * FILE: src/core/triage.ts
 * PURPOSE: Performs risk assessment on each changed file BEFORE the AI review.
 *          Determines which security-sensitive areas a file touches (auth, db,
 *          crypto, etc.) and assigns a risk level (high/medium/low).
 *
 * WHY TRIAGE FIRST?
 *   - Gives AI agents focused context ("this file touches auth and crypto")
 *   - High-risk files get more careful review attention
 *   - Risk level is shown in CI logs and markdown reports
 *   - Agents can filter their output based on the risk context
 *
 * RISK LEVELS:
 *   high   → file touches any of: auth, db, crypto, env (security-sensitive domains)
 *   medium → file touches 3 or more concern areas (complex, multi-domain code)
 *   low    → everything else (default, no special sensitivity detected)
 *
 * AREA DETECTION:
 *   Uses regex patterns on the full file content (or added lines as fallback).
 *   Merges language default areas (from language-profiles.ts) with dynamically
 *   detected areas to get the full picture of what the file is doing.
 * ============================================================
 */

import type { ParsedDiffFile, RiskLevel, TriageResult } from "../types.js";

/**
 * Regex patterns for detecting sensitive code areas.
 * Each pattern matches keywords commonly associated with that concern domain.
 * These run against the full file content to find ANY sensitive usage.
 *
 * Note: These are intentionally broad (case-insensitive) — false positives are
 * acceptable here since the goal is conservative risk detection, not precision.
 */
const AREA_PATTERNS: Array<{ area: string; regex: RegExp }> = [
  {
    area: "auth",
    // Matches authentication, login flows, tokens, sessions, JWTs, role checks
    regex: /\bauth|login|token|session|jwt|role\b/i
  },
  {
    area: "api",
    // Matches HTTP calls, request/response handling, controllers, and routes
    regex: /\bfetch|axios|request|response|controller|route\b/i
  },
  {
    area: "db",
    // Matches database operations: SQL, ORM queries, repository patterns
    regex: /\bselect|insert|update|delete|query|repository|model\b/i
  },
  {
    area: "async",
    // Matches async patterns: await, Promise, setTimeout, task queues
    regex: /\bawait|promise|async|settimeout|queue\b/i
  },
  {
    area: "filesystem",
    // Matches file system operations: node:fs, path manipulation, file open
    regex: /\bfs\.|readfile|writefile|path\.|open\(/i
  },
  {
    area: "env",
    // Matches environment variables, secrets, API keys, passwords
    regex: /\bprocess\.env|dotenv|secret|apikey|password\b/i
  },
  {
    area: "validation",
    // Matches input validation, schema checking, sanitization, parsing
    regex: /\bvalidate|schema|sanitize|escape|parse\b/i
  },
  {
    area: "crypto",
    // Matches cryptographic operations: hashing, encryption, crypto module
    regex: /\bcrypt|hash|encrypt|decrypt|crypto\b/i
  }
];

/**
 * Analyzes a parsed diff file and returns a TriageResult with:
 *   - needs_review: whether the file has any added lines to review
 *   - risk_level: high/medium/low based on detected concern areas
 *   - areas_of_concern: all areas this file touches (default + dynamically detected)
 *   - verdict: a human-readable one-liner for logs and reports
 *
 * Uses the full file content (fullFileLines) when available to detect areas
 * across the entire file — not just in the changed lines. Falls back to
 * addedLines if the full file wasn't readable (e.g., new file, not on disk).
 */
export function triageFile(file: ParsedDiffFile): TriageResult {
  // Prefer full file content for detection — changed lines alone may miss
  // sensitive patterns that exist elsewhere in the file.
  const reviewSource = file.fullFileLines?.length ? file.fullFileLines : file.addedLines;
  const addedText = reviewSource.map((item) => item.content).join("\n");

  // Run each area pattern against the combined text to find all concern areas
  const dynamicAreas = AREA_PATTERNS
    .filter((item) => item.regex.test(addedText)) // Test if pattern matches anywhere in file
    .map((item) => item.area);                     // Collect matching area names

  // Merge language default areas (from language-profiles.ts) with dynamic detections.
  // Deduplicate with Set so the same area isn't listed twice.
  const areas = [...new Set([...file.defaultAreas, ...dynamicAreas])];

  // Assign risk level:
  //   high   → any security-critical area (auth, db, crypto, env)
  //   medium → 3+ areas touched (multi-domain, complex code)
  //   low    → everything else
  const riskLevel: RiskLevel =
    areas.some((area) => ["auth", "db", "crypto", "env"].includes(area)) ? "high" :
    areas.length >= 3 ? "medium" :
    "low";

  return {
    // A file only needs review if it has added lines — deleted-only files have nothing to check
    needs_review: file.addedLines.length > 0,

    risk_level: riskLevel,

    areas_of_concern: areas,

    // One-liner verdict shown in logs, CI output, and markdown reports
    verdict:
      file.addedLines.length === 0
        ? "No added lines detected."
        : `Review touched file ${file.file} in ${file.language} with ${riskLevel} risk.`
  };
}
