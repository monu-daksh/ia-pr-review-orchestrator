import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ENV_FILES = [
  ".env",
  ".env.local",
  ".pr-review-orchestrator",         // secrets + model config created by init
  ".env.pr-review-orchestrator",     // legacy / manual alternative
  ".env.pr-review-orchestrator.local"
];

const CONFIG_FILE = "pr-review-orchestrator.config.json";

interface ProjectConfig {
  provider?: string;
  models?: {
    groq?: string;
    anthropic?: string;
    gemini?: string;
    openai?: string;
    ollama?: string;
  };
}

const PLACEHOLDER_PATTERNS = [
  /^your[_-]/i,
  /^replace[_-]/i,
  /^paste[_-]/i,
  /^add[_-]/i,
  /api[_-]?key[_-]?here/i,
  /token[_-]?here/i
];

export function isConfiguredValue(value: string | undefined | null): boolean {
  if (!value) return false;

  const normalized = value.trim();
  if (!normalized) return false;

  return !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Reads pr-review-orchestrator.config.json from the working repo and
 * applies provider + model settings as env defaults (only if not already set).
 * This lets each working repo control which AI provider and model to use
 * without any code changes to the library.
 */
async function loadProjectConfig(rootDir: string): Promise<void> {
  const configPath = path.join(rootDir, CONFIG_FILE);
  let config: ProjectConfig;

  try {
    const raw = await fs.readFile(configPath, "utf8");
    config = JSON.parse(raw) as ProjectConfig;
  } catch {
    return; // no config file — that's fine
  }

  if (config.provider && !("PR_REVIEW_PROVIDER" in process.env)) {
    process.env.PR_REVIEW_PROVIDER = config.provider;
  }

  const models = config.models ?? {};
  const modelMap: Record<string, string> = {
    groq: "GROQ_MODEL",
    anthropic: "ANTHROPIC_MODEL",
    gemini: "GEMINI_MODEL",
    openai: "OPENAI_MODEL",
    ollama: "OLLAMA_MODEL"
  };

  for (const [provider, envKey] of Object.entries(modelMap)) {
    const model = models[provider as keyof typeof models];
    if (model && !(envKey in process.env)) {
      process.env[envKey] = model;
    }
  }
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(normalized.slice(separatorIndex + 1).trim());

    if (key) {
      values[key] = value;
    }
  }

  return values;
}

export async function loadProjectEnv(rootDir = process.cwd()): Promise<string[]> {
  const loadedFiles: string[] = [];

  // .env files load first — they take priority over the config file
  for (const fileName of DEFAULT_ENV_FILES) {
    const filePath = path.join(rootDir, fileName);

    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = parseEnvFile(content);

      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }

      loadedFiles.push(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  // Config file loads last — fills in provider + model defaults not already set
  // Priority: GitHub Secrets / CI env > .env files > pr-review-orchestrator.config.json
  await loadProjectConfig(rootDir);

  return loadedFiles;
}
