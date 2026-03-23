/**
 * ============================================================
 * FILE: src/reporters/html-reporter.ts
 * PURPOSE: Converts a ReviewResult into a self-contained HTML page
 *          with full CSS styling for a polished, readable issue display.
 *
 * OUTPUT: A complete HTML string with:
 *   - Summary dashboard (decision badge, severity counts, agent run table)
 *   - Per-file sections with collapsible finding cards
 *   - Severity-coded cards (critical=red, high=orange, medium=yellow, low=blue)
 *   - Agent badges, code snippets, and syntax-highlighted fix blocks
 *   - Fully self-contained — no external dependencies
 *
 * USAGE:
 *   import { buildHTMLReport } from "pr-review-orchestrator";
 *   const html = buildHTMLReport(reviewResult);
 *   fs.writeFileSync("review.html", html);
 * ============================================================
 */

import type { NormalizedFinding, ReviewResult } from "../types.js";

// ─── Badge & Label Maps ───────────────────────────────────────────────────────

/** CSS class suffix for each severity level */
const SEVERITY_CLASS: Record<string, string> = {
  critical: "critical",
  high:     "high",
  medium:   "medium",
  low:      "low"
};

/** Display label + emoji for each severity level */
const SEVERITY_LABEL: Record<string, string> = {
  critical: "🔴 CRITICAL",
  high:     "🟠 HIGH",
  medium:   "🟡 MEDIUM",
  low:      "🔵 LOW"
};

/** Emoji + label for each agent */
const AGENT_LABEL: Record<string, string> = {
  security:       "🛡️ Security",
  bug:            "🐛 Bug",
  logic:          "🧠 Logic",
  types:          "📐 Types",
  eslint:         "🔍 ESLint",
  performance:    "⚡ Performance",
  "best-practices":"✅ Best Practices",
  quality:        "🏗️ Quality",
  fix:            "🔧 Fix"
};

// ─── CSS ─────────────────────────────────────────────────────────────────────

/**
 * Returns the full CSS stylesheet as a string.
 * Uses CSS custom properties (variables) for theming and consistent colors.
 * Dark theme based on GitHub's color palette.
 */
function getCSS(): string {
  return `
    /* ── Reset & Base ─────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:           #0d1117;
      --surface:      #161b22;
      --surface-2:    #1c2128;
      --border:       #30363d;
      --border-light: #21262d;
      --text:         #e6edf3;
      --text-muted:   #7d8590;
      --text-dim:     #484f58;

      /* Severity colors */
      --critical:     #ff4d4d;
      --critical-bg:  rgba(255, 77, 77, 0.08);
      --critical-bdr: rgba(255, 77, 77, 0.35);
      --high:         #f0883e;
      --high-bg:      rgba(240, 136, 62, 0.08);
      --high-bdr:     rgba(240, 136, 62, 0.35);
      --medium:       #d29922;
      --medium-bg:    rgba(210, 153, 34, 0.08);
      --medium-bdr:   rgba(210, 153, 34, 0.35);
      --low:          #4dabf7;
      --low-bg:       rgba(77, 171, 247, 0.08);
      --low-bdr:      rgba(77, 171, 247, 0.35);

      /* Status */
      --approve:      #3fb950;
      --approve-bg:   rgba(63, 185, 80, 0.1);
      --request:      #f85149;
      --request-bg:   rgba(248, 81, 73, 0.1);

      --accent:       #388bfd;
      --accent-bg:    rgba(56, 139, 253, 0.1);
      --code-bg:      #161b22;
      --radius:       8px;
      --radius-sm:    4px;
      --shadow:       0 1px 3px rgba(0,0,0,0.4);
      --shadow-md:    0 4px 12px rgba(0,0,0,0.5);
    }

    html { font-size: 14px; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 24px 16px 64px;
    }

    /* ── Layout ───────────────────────────────────────────────────── */
    .container { max-width: 960px; margin: 0 auto; }

    /* ── Header ───────────────────────────────────────────────────── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding: 20px 0 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 28px;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-title h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.3px;
      color: var(--text);
    }

    .header-icon {
      font-size: 22px;
      line-height: 1;
    }

    /* ── Decision Badge ───────────────────────────────────────────── */
    .decision-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }

    .decision-badge.approve {
      background: var(--approve-bg);
      color: var(--approve);
      border: 1px solid rgba(63, 185, 80, 0.3);
    }

    .decision-badge.request_changes {
      background: var(--request-bg);
      color: var(--request);
      border: 1px solid rgba(248, 81, 73, 0.3);
    }

    /* ── Summary Stats ────────────────────────────────────────────── */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
      margin-bottom: 28px;
    }

    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      text-align: center;
      position: relative;
      overflow: hidden;
      transition: border-color 0.15s;
    }

    .stat-card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
    }

    .stat-card.total::before   { background: var(--accent); }
    .stat-card.critical::before{ background: var(--critical); }
    .stat-card.high::before    { background: var(--high); }
    .stat-card.medium::before  { background: var(--medium); }
    .stat-card.low::before     { background: var(--low); }

    .stat-card:hover { border-color: var(--accent); }

    .stat-number {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.2;
      margin-bottom: 4px;
    }

    .stat-card.total   .stat-number { color: var(--text); }
    .stat-card.critical .stat-number { color: var(--critical); }
    .stat-card.high     .stat-number { color: var(--high); }
    .stat-card.medium   .stat-number { color: var(--medium); }
    .stat-card.low      .stat-number { color: var(--low); }

    .stat-label {
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
    }

    /* ── Agent Run Table ──────────────────────────────────────────── */
    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-title::after {
      content: "";
      flex: 1;
      height: 1px;
      background: var(--border);
    }

    .agent-table {
      width: 100%;
      border-collapse: collapse;
      border-radius: var(--radius);
      overflow: hidden;
      border: 1px solid var(--border);
      margin-bottom: 32px;
      font-size: 13px;
    }

    .agent-table thead { background: var(--surface-2); }

    .agent-table th {
      padding: 10px 14px;
      text-align: left;
      color: var(--text-muted);
      font-weight: 500;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      border-bottom: 1px solid var(--border);
    }

    .agent-table td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border-light);
      color: var(--text);
    }

    .agent-table tbody tr:last-child td { border-bottom: none; }

    .agent-table tbody tr:hover { background: var(--surface-2); }

    .agent-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-weight: 500;
    }

    .agent-count-bar {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .count-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 20px;
      padding: 0 7px;
      background: var(--accent-bg);
      color: var(--accent);
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }

    .count-pill.zero { background: transparent; color: var(--text-dim); }

    /* ── File Section ─────────────────────────────────────────────── */
    .file-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 20px;
      overflow: hidden;
    }

    .file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      user-select: none;
      gap: 12px;
    }

    .file-header:hover { background: #1e252e; }

    .file-path {
      font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
      font-size: 13px;
      color: var(--accent);
      font-weight: 500;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-badges {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .file-toggle {
      color: var(--text-muted);
      font-size: 11px;
      transition: transform 0.2s;
    }

    .file-section.open .file-toggle { transform: rotate(180deg); }

    /* ── Finding Card ─────────────────────────────────────────────── */
    .findings-list { padding: 12px; display: flex; flex-direction: column; gap: 10px; }

    .finding-card {
      border-radius: var(--radius-sm);
      border-left: 3px solid;
      overflow: hidden;
      transition: box-shadow 0.15s;
    }

    .finding-card:hover { box-shadow: var(--shadow-md); }

    .finding-card.critical {
      background: var(--critical-bg);
      border-color: var(--critical);
    }
    .finding-card.high {
      background: var(--high-bg);
      border-color: var(--high);
    }
    .finding-card.medium {
      background: var(--medium-bg);
      border-color: var(--medium);
    }
    .finding-card.low {
      background: var(--low-bg);
      border-color: var(--low);
    }

    .finding-header {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px 8px;
      flex-wrap: wrap;
    }

    .severity-tag {
      display: inline-flex;
      align-items: center;
      padding: 2px 9px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.4px;
      flex-shrink: 0;
      white-space: nowrap;
    }

    .severity-tag.critical { background: rgba(255,77,77,0.2);  color: var(--critical); border: 1px solid var(--critical-bdr); }
    .severity-tag.high     { background: rgba(240,136,62,0.2); color: var(--high);     border: 1px solid var(--high-bdr); }
    .severity-tag.medium   { background: rgba(210,153,34,0.2); color: var(--medium);   border: 1px solid var(--medium-bdr); }
    .severity-tag.low      { background: rgba(77,171,247,0.2); color: var(--low);      border: 1px solid var(--low-bdr); }

    .finding-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      flex: 1;
      min-width: 0;
    }

    .finding-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 14px 10px;
      flex-wrap: wrap;
    }

    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--text-muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 2px 7px;
    }

    .meta-chip code {
      font-family: "SF Mono", "Fira Code", Consolas, monospace;
      font-size: 11px;
    }

    .confidence-bar-wrap {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .confidence-bar {
      width: 50px;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      overflow: hidden;
    }

    .confidence-fill {
      height: 100%;
      border-radius: 2px;
      background: var(--accent);
    }

    /* ── Issue Description ────────────────────────────────────────── */
    .finding-body { padding: 0 14px 12px; }

    .finding-issue-text {
      font-size: 13px;
      color: #b0bac4;
      line-height: 1.65;
      margin-bottom: 12px;
    }

    /* ── Code Blocks ──────────────────────────────────────────────── */
    .code-block-wrap { margin-bottom: 10px; }

    .code-block-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-bottom: 5px;
    }

    .code-block-label.fix-label { color: var(--approve); }

    pre.code-block {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      overflow-x: auto;
      font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
      font-size: 12px;
      line-height: 1.7;
      color: #adbac7;
      white-space: pre;
    }

    pre.code-block.fix-block {
      border-color: rgba(63, 185, 80, 0.25);
      background: rgba(63, 185, 80, 0.04);
    }

    /* ── Empty State ──────────────────────────────────────────────── */
    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
    }

    .empty-state-icon { font-size: 40px; margin-bottom: 12px; }
    .empty-state h3 { font-size: 16px; color: var(--approve); margin-bottom: 6px; }
    .empty-state p  { font-size: 13px; }

    /* ── Pipeline Info ────────────────────────────────────────────── */
    .pipeline-steps {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 28px;
    }

    .pipeline-step {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .pipeline-step .step-num {
      font-weight: 700;
      color: var(--accent);
      font-size: 10px;
    }

    /* ── Scrollbar Styling ────────────────────────────────────────── */
    pre::-webkit-scrollbar { height: 6px; }
    pre::-webkit-scrollbar-track { background: transparent; }
    pre::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    pre::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }

    /* ── Responsive ───────────────────────────────────────────────── */
    @media (max-width: 600px) {
      .stats-grid { grid-template-columns: repeat(3, 1fr); }
      .finding-header { flex-wrap: wrap; }
    }
  `.trim();
}

// ─── HTML Building Blocks ─────────────────────────────────────────────────────

/**
 * Escapes characters that have special meaning in HTML.
 * Prevents XSS if any finding text contains < > & etc.
 */
function esc(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders the top-level stats grid (total, critical, high, medium, low counts).
 */
function renderStatsGrid(review: ReviewResult): string {
  const { summary } = review;
  const stats = [
    { key: "total",    num: summary.total_issues,    label: "Total Issues" },
    { key: "critical", num: summary.critical_count,  label: "Critical" },
    { key: "high",     num: summary.high_count,       label: "High" },
    { key: "medium",   num: summary.medium_count,     label: "Medium" },
    { key: "low",      num: summary.low_count,        label: "Low" }
  ];

  const cards = stats.map(({ key, num, label }) => `
    <div class="stat-card ${key}">
      <div class="stat-number">${num}</div>
      <div class="stat-label">${label}</div>
    </div>`
  ).join("");

  return `<div class="stats-grid">${cards}</div>`;
}

/**
 * Renders the agent run summary table showing how many findings each agent produced.
 */
function renderAgentTable(review: ReviewResult): string {
  if (!review.reports.agent_runs?.length) return "";

  const rows = review.reports.agent_runs.map((run) => {
    const label = AGENT_LABEL[run.agent] ?? run.agent;
    const countClass = run.findings === 0 ? "zero" : "";
    return `
      <tr>
        <td><span class="agent-badge">${esc(label)}</span></td>
        <td>
          <div class="agent-count-bar">
            <span class="count-pill ${countClass}">${run.findings}</span>
            ${run.findings > 0 ? `<span style="font-size:11px;color:var(--text-muted)">finding${run.findings !== 1 ? "s" : ""}</span>` : ""}
          </div>
        </td>
        <td><span style="color:var(--approve);font-size:12px">✓ ${esc(run.status)}</span></td>
      </tr>`;
  }).join("");

  return `
    <div class="section-title">Agent Runs</div>
    <table class="agent-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Findings</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Renders the 6 pipeline step badges shown under the header.
 */
function renderPipelineSteps(): string {
  const steps = [
    "Detection",
    "Aggregation",
    "Decision Engine",
    "Context Awareness",
    "Self-Check",
    "Fix Generation"
  ];

  const badges = steps.map((label, i) => `
    <div class="pipeline-step">
      <span class="step-num">${i + 1}</span>
      ${esc(label)}
    </div>`
  ).join("");

  return `<div class="pipeline-steps">${badges}</div>`;
}

/**
 * Renders a single finding card with severity styling, meta chips, issue text,
 * optional code snippet, and optional fix code block.
 */
function renderFindingCard(finding: NormalizedFinding): string {
  const sevClass = SEVERITY_CLASS[finding.severity] ?? "low";
  const sevLabel = SEVERITY_LABEL[finding.severity] ?? finding.severity.toUpperCase();
  const agentLabel = AGENT_LABEL[finding.agent] ?? finding.agent;
  const confidence = typeof finding.confidence === "number" ? finding.confidence : 0;
  const confidencePct = Math.round(confidence * 100);

  // Code snippet block
  const snippetBlock = finding.code_snippet?.trim()
    ? `<div class="code-block-wrap">
         <div class="code-block-label">Code</div>
         <pre class="code-block">${esc(finding.code_snippet.trim())}</pre>
       </div>`
    : "";

  // Fix code block
  const fixBlock = finding.corrected_code?.trim()
    ? `<div class="code-block-wrap">
         <div class="code-block-label fix-label">🔧 Suggested Fix</div>
         <pre class="code-block fix-block">${esc(finding.corrected_code.trim())}</pre>
       </div>`
    : "";

  return `
    <div class="finding-card ${sevClass}">
      <div class="finding-header">
        <span class="severity-tag ${sevClass}">${sevLabel}</span>
        <span class="finding-title">${esc(finding.title)}</span>
      </div>
      <div class="finding-meta">
        <span class="meta-chip">
          ${esc(agentLabel)}
        </span>
        <span class="meta-chip">
          <code>${esc(finding.file)}:${finding.line}</code>
        </span>
        <span class="meta-chip">
          ${esc(finding.category)}
        </span>
        <span class="confidence-bar-wrap">
          <div class="confidence-bar">
            <div class="confidence-fill" style="width:${confidencePct}%"></div>
          </div>
          <span>${confidencePct}% confidence</span>
        </span>
      </div>
      <div class="finding-body">
        <p class="finding-issue-text">${esc(finding.issue)}</p>
        ${snippetBlock}
        ${fixBlock}
      </div>
    </div>`;
}

/**
 * Renders all findings grouped by file, each group in a collapsible file section.
 */
function renderFilesSections(review: ReviewResult): string {
  // Use the flat findings list for rendering
  const findings = review.reports.findings ?? [];

  if (findings.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">✅</div>
        <h3>No findings detected</h3>
        <p>All reviewed files look clean — no issues were found.</p>
      </div>`;
  }

  // Group findings by file
  const byFile = new Map<string, NormalizedFinding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.file) ?? [];
    list.push(finding);
    byFile.set(finding.file, list);
  }

  const sections: string[] = [];
  for (const [file, filefindings] of byFile) {
    // Severity summary badges for the file header
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of filefindings) {
      if (f.severity in counts) counts[f.severity as keyof typeof counts]++;
    }

    const badgeHtml = (Object.entries(counts) as [string, number][])
      .filter(([, count]) => count > 0)
      .map(([sev, count]) => `<span class="severity-tag ${sev}" style="font-size:10px;">${count} ${SEVERITY_LABEL[sev] ?? sev.toUpperCase()}</span>`)
      .join("");

    const cards = filefindings.map(renderFindingCard).join("");

    sections.push(`
      <div class="file-section open">
        <div class="file-header" onclick="this.parentElement.classList.toggle('open'); this.querySelector('.file-toggle').style.transform = this.parentElement.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)'">
          <span class="file-path">${esc(file)}</span>
          <div class="file-badges">${badgeHtml}</div>
          <span class="file-toggle">▼</span>
        </div>
        <div class="findings-list" style="display:none">
          ${cards}
        </div>
      </div>`);
  }

  return sections.join("");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds a complete self-contained HTML page from a ReviewResult.
 * The page includes all CSS inline, requires no external dependencies,
 * and can be saved as a .html file or served directly from an Express endpoint.
 *
 * @param review - The ReviewResult from reviewDiff()
 * @returns Full HTML string (<!DOCTYPE html> ... </html>)
 */
export function buildHTMLReport(review: ReviewResult): string {
  const decision = review.summary.final_decision;
  const decisionLabel = decision === "approve" ? "✅ Approved" : "🚫 Changes Requested";
  const totalFiles = review.summary.total_files;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PR Review Report</title>
  <style>${getCSS()}</style>
</head>
<body>
  <div class="container">

    <!-- Header -->
    <div class="header">
      <div class="header-title">
        <span class="header-icon">🔍</span>
        <h1>PR Review Orchestrator</h1>
      </div>
      <span class="decision-badge ${decision}">${decisionLabel}</span>
    </div>

    <!-- Pipeline Steps -->
    ${renderPipelineSteps()}

    <!-- Summary Stats -->
    ${renderStatsGrid(review)}

    <!-- File count note -->
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:20px;">
      ${totalFiles} file${totalFiles !== 1 ? "s" : ""} reviewed &nbsp;·&nbsp;
      ${review.summary.total_issues} total issue${review.summary.total_issues !== 1 ? "s" : ""} found
    </p>

    <!-- Agent Run Table -->
    ${renderAgentTable(review)}

    <!-- Findings by File -->
    <div class="section-title">Findings</div>
    ${renderFilesSections(review)}

  </div>

  <script>
    /* Auto-expand file sections that have critical or high findings */
    document.querySelectorAll(".file-section").forEach(function(section) {
      var hasCritical = section.querySelector(".finding-card.critical, .finding-card.high");
      var list = section.querySelector(".findings-list");
      if (hasCritical) {
        list.style.display = "flex";
      } else {
        list.style.display = "none";
        section.classList.remove("open");
      }
    });

    /* Toggle file section visibility */
    document.querySelectorAll(".file-header").forEach(function(header) {
      header.addEventListener("click", function() {
        var section = this.parentElement;
        var list = section.querySelector(".findings-list");
        var isOpen = section.classList.contains("open");
        if (isOpen) {
          list.style.display = "none";
          section.classList.remove("open");
        } else {
          list.style.display = "flex";
          section.classList.add("open");
        }
      });
    });
  </script>
</body>
</html>`;
}
