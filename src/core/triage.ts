import type { ParsedDiffFile, RiskLevel, TriageResult } from "../types.js";

const AREA_PATTERNS: Array<{ area: string; regex: RegExp }> = [
  { area: "auth", regex: /\bauth|login|token|session|jwt|role\b/i },
  { area: "api", regex: /\bfetch|axios|request|response|controller|route\b/i },
  { area: "db", regex: /\bselect|insert|update|delete|query|repository|model\b/i },
  { area: "async", regex: /\bawait|promise|async|settimeout|queue\b/i },
  { area: "filesystem", regex: /\bfs\.|readfile|writefile|path\.|open\(/i },
  { area: "env", regex: /\bprocess\.env|dotenv|secret|apikey|password\b/i },
  { area: "validation", regex: /\bvalidate|schema|sanitize|escape|parse\b/i },
  { area: "crypto", regex: /\bcrypt|hash|encrypt|decrypt|crypto\b/i }
];

export function triageFile(file: ParsedDiffFile): TriageResult {
  const reviewSource = file.fullFileLines?.length ? file.fullFileLines : file.addedLines;
  const addedText = reviewSource.map((item) => item.content).join("\n");
  const dynamicAreas = AREA_PATTERNS
    .filter((item) => item.regex.test(addedText))
    .map((item) => item.area);

  const areas = [...new Set([...file.defaultAreas, ...dynamicAreas])];
  const riskLevel: RiskLevel =
    areas.some((area) => ["auth", "db", "crypto", "env"].includes(area)) ? "high" :
    areas.length >= 3 ? "medium" :
    "low";

  return {
    needs_review: file.addedLines.length > 0,
    risk_level: riskLevel,
    areas_of_concern: areas,
    verdict:
      file.addedLines.length === 0
        ? "No added lines detected."
        : `Review touched file ${file.file} in ${file.language} with ${riskLevel} risk.`
  };
}

