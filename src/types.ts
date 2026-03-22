export type RiskLevel = "low" | "medium" | "high";
export type Severity = "critical" | "high" | "medium" | "low";
export type IssueCategory = "bug" | "security" | "performance" | "quality";
export type AgentName = "security" | "bug" | "logic" | "types" | "eslint" | "performance" | "best-practices" | "quality" | "fix";
export type ProviderName = "multi-agent" | "claude" | "groq" | "gemini" | "ollama" | "openai" | "local";
export type InstallProviderChoice = "groq" | "gemini" | "ollama" | "anthropic" | "openai" | "local";

export interface AddedLine {
  line: number;
  content: string;
}

export interface ContextLine {
  line: number;
  content: string;
}

export interface LanguageProfile {
  language: string;
  extensions: string[];
  areas: string[];
  type: string;
}

export interface ParsedDiffFile {
  file: string;
  language: string;
  changeType: string;
  defaultAreas: string[];
  addedLines: AddedLine[];
  contextLines: ContextLine[];
  fullFileLines?: ContextLine[];
}

export interface TriageResult {
  needs_review: boolean;
  risk_level: RiskLevel;
  areas_of_concern: string[];
  verdict: string;
}

export interface TriagedFile extends ParsedDiffFile {
  triage: TriageResult;
}

export interface ReviewIssue {
  id: string;
  category: IssueCategory;
  severity: Severity;
  agent: AgentName;
  file: string;
  line: number;
  code_snippet: string;
  title: string;
  message: string;
  suggestion: string;
  corrected_code?: string;
  labels: string[];
  confidence: number;
}

export interface SecurityIssue {
  id: string;
  category: "security";
  severity: Severity;
  agent: "security";
  file: string;
  line: number;
  code_snippet: string;
  title: string;
  message: string;
  fix: string;
  corrected_code?: string;
  labels: string[];
  confidence: number;
}

export interface Patch {
  file: string;
  line: number;
  original: string;
  fixed: string;
}

export interface PRComment {
  id: string;
  file: string;
  line: number;
  agent: AgentName;
  severity: Severity;
  category: IssueCategory;
  title: string;
  issue: string;
  code_snippet: string;
  corrected_code: string;
  labels: string[];
  body: string;
}

export interface AgentRunSummary {
  agent: AgentName;
  findings: number;
  status: "completed";
}

export interface NormalizedFinding {
  id: string;
  file: string;
  line: number;
  agent: AgentName;
  category: IssueCategory;
  severity: Severity;
  title: string;
  issue: string;
  code_snippet: string;
  corrected_code?: string;
  labels: string[];
  confidence: number;
}

export interface FileFindingSummary {
  file: string;
  total_findings: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
}

export interface ReviewFileResult {
  file: string;
  language: string;
  triage: TriageResult;
  review: {
    issues: ReviewIssue[];
  };
  security: {
    vulnerabilities: SecurityIssue[];
  };
  fix: {
    required: boolean;
    fixed_code: string;
    patches: Patch[];
    changes_summary: string[];
  };
}

export interface ReviewResult {
  files: ReviewFileResult[];
  summary: {
    total_files: number;
    total_issues: number;
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
    final_decision: "approve" | "request_changes";
  };
  reports: {
    pr_comments: PRComment[];
    agent_runs: AgentRunSummary[];
    findings: NormalizedFinding[];
    files: FileFindingSummary[];
    markdown_summary: string;
  };
}

export interface PromptPayload {
  system: string;
  user: {
    instructions: string[];
    files: Array<{
      file: string;
      language: string;
      change_type: string;
      added_lines: AddedLine[];
      context_preview: ContextLine[];
      full_file_lines?: ContextLine[];
    }>;
  };
}

export interface ReviewProvider {
  review(promptPayload: PromptPayload, triagedFiles: TriagedFile[]): Promise<ReviewResult>;
}

export interface ReviewOptions {
  dryRun?: boolean;
  provider?: string;
  format?: "json" | "github-pr";
}

export interface DryRunResult {
  parsed_files: TriagedFile[];
  prompt_payload: PromptPayload;
}
