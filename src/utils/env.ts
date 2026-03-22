import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.pr-review-orchestrator",
  ".env.pr-review-orchestrator.local",
  ".pr-review-orchestrator"
];

const TOOL_DIR = "pr-review-orchestrator";
const PROJECT_CONFIG_PATH = path.join(TOOL_DIR, "config.json");
const LOCAL_CONFIG_PATH = path.join(TOOL_DIR, "local.json");
const LEGACY_CONFIG_FILE = "pr-review-orchestrator.config.json";

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

interface LocalConfig {
  provider?: string;
  selectedProvider?: string;
  models?: ProjectConfig["models"];
  apiKeys?: {
    groq?: string;
    anthropic?: string;
    gemini?: string;
    openai?: string;
    ollamaHost?: string;
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

async function loadJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function applyModelDefaults(models: ProjectConfig["models"] | undefined): void {
  if (!models) return;

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

async function loadProjectConfig(rootDir: string): Promise<void> {
  const config =
    await loadJsonFile<ProjectConfig>(path.join(rootDir, PROJECT_CONFIG_PATH)) ??
    await loadJsonFile<ProjectConfig>(path.join(rootDir, LEGACY_CONFIG_FILE));

  if (!config) return;

  if (config.provider && !("PR_REVIEW_PROVIDER" in process.env)) {
    process.env.PR_REVIEW_PROVIDER = config.provider;
  }

  applyModelDefaults(config.models);
}

async function loadLocalJsonConfig(rootDir: string): Promise<string[]> {
  const filePath = path.join(rootDir, LOCAL_CONFIG_PATH);
  const config = await loadJsonFile<LocalConfig>(filePath);
  if (!config) return [];

  if (config.provider && !("PR_REVIEW_PROVIDER" in process.env)) {
    process.env.PR_REVIEW_PROVIDER = config.provider;
  }

  applyModelDefaults(config.models);

  const apiKeys = config.apiKeys ?? {};
  const keyMap: Record<string, string | undefined> = {
    GROQ_API_KEY: apiKeys.groq,
    ANTHROPIC_API_KEY: apiKeys.anthropic,
    GEMINI_API_KEY: apiKeys.gemini,
    OPENAI_API_KEY: apiKeys.openai,
    OLLAMA_HOST: apiKeys.ollamaHost
  };

  for (const [envKey, value] of Object.entries(keyMap)) {
    if (value && !(envKey in process.env)) {
      process.env[envKey] = value;
    }
  }

  return [filePath];
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

    if (key) values[key] = value;
  }

  return values;
}

export async function loadProjectEnv(rootDir = process.cwd()): Promise<string[]> {
  const loadedFiles: string[] = [];

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
      if (code !== "ENOENT") throw error;
    }
  }

  loadedFiles.push(...await loadLocalJsonConfig(rootDir));
  await loadProjectConfig(rootDir);

  return loadedFiles;
}
