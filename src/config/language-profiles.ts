/**
 * ============================================================
 * FILE: src/config/language-profiles.ts
 * PURPOSE: Maps file extensions to language metadata used throughout the review.
 *
 * WHAT IT DOES:
 *   - Detects which programming language a file is written in (by extension)
 *   - Assigns default "areas of concern" for each language that run even before
 *     triage analysis — e.g., all TypeScript files are checked for "api" and "async"
 *   - Classifies files as "logic", "config", or "dependency" to help agents
 *     understand whether a file contains executable code or just configuration
 *
 * HOW IT'S USED:
 *   - diff-parser.ts calls detectLanguage() for every file in the diff
 *   - triage.ts merges defaultAreas with dynamically detected areas
 *   - Agents use the language name in their prompts for language-specific advice
 *
 * HOW TO ADD A NEW LANGUAGE:
 *   Add a new entry to LANGUAGE_PROFILES before the "Unknown" fallback.
 *   Set `areas` to the security/quality concerns most relevant to that language.
 * ============================================================
 */

import type { LanguageProfile } from "../types.js";

/**
 * All supported language profiles.
 * Order matters: the first matching extension wins.
 * The "Unknown" entry at the end is the fallback for unrecognized extensions.
 *
 * Area values and what they trigger in triage:
 *   "api"        → API calls, controllers, routes (triage detects fetch, axios, etc.)
 *   "async"      → Async patterns (triage detects await, Promise, setTimeout)
 *   "validation" → Input validation (triage detects validate, sanitize, parse)
 *   "env"        → Environment variables and secrets (triage detects process.env, password)
 *   "auth"       → Authentication (HIGH RISK — triggers high risk level in triage)
 *   "db"         → Database (HIGH RISK — triggers high risk level in triage)
 *   "crypto"     → Cryptography (HIGH RISK — triggers high risk level in triage)
 *   "filesystem" → File system operations
 *   "security"   → General security (shell scripts, etc.)
 *   "config"     → Configuration file
 *   "dependency" → Package/dependency management
 *   "ui"         → UI/styling (CSS, SCSS)
 */
export const LANGUAGE_PROFILES: LanguageProfile[] = [
  {
    language: "TypeScript",
    extensions: [".ts", ".tsx"],    // TypeScript source files and React TSX components
    areas: ["api", "async", "validation", "env"], // Common TS concerns: HTTP calls, async patterns, input validation, env vars
    type: "logic"                   // Contains executable code
  },
  {
    language: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"], // JS source, React JSX, ESM, CommonJS modules
    areas: ["api", "async", "validation", "env"], // Same concerns as TypeScript
    type: "logic"
  },
  {
    language: "Stylesheet",
    extensions: [".css", ".scss", ".sass", ".less"], // CSS and preprocessors
    areas: ["ui", "config"],        // Stylesheets: UI layout/styling concerns
    type: "logic"                   // Stylesheets are "logic" (they affect behavior/layout)
  },
  {
    language: "Python",
    extensions: [".py"],            // Python source files
    areas: ["api", "db", "validation", "filesystem", "crypto"], // Python often does all of these
    type: "logic"
  },
  {
    language: "Java",
    extensions: [".java"],          // Java source files
    areas: ["api", "db", "validation", "auth", "config"], // Java enterprise: auth is common
    type: "logic"
  },
  {
    language: "Kotlin",
    extensions: [".kt"],            // Kotlin source files (Android, server-side)
    areas: ["api", "db", "validation", "auth", "config"], // Same as Java concerns
    type: "logic"
  },
  {
    language: "JSON",
    extensions: [".json"],          // JSON config and data files
    areas: ["config", "dependency"], // JSON is typically config or package deps
    type: "config"                   // Not executable — just data/config
  },
  {
    language: "YAML",
    extensions: [".yml", ".yaml"],  // YAML config, CI pipelines, Kubernetes manifests
    areas: ["config", "env", "dependency"], // YAML often contains env values and CI config
    type: "config"
  },
  {
    language: "XML",
    extensions: [".xml"],           // XML config, Android manifests, Spring configs
    areas: ["config", "dependency"],
    type: "config"
  },
  {
    language: "Gradle",
    extensions: [".gradle"],        // Gradle build scripts (Android/Java projects)
    areas: ["config", "dependency"], // Build scripts manage dependencies and config
    type: "dependency"               // Dependency management file
  },
  {
    language: "Maven",
    extensions: [".pom"],           // Maven POM files (Java projects)
    areas: ["config", "dependency"],
    type: "dependency"
  },
  {
    language: "Properties",
    extensions: [".properties"],    // Java .properties config files
    areas: ["config", "env"],       // Often contain environment-specific settings
    type: "config"
  },
  {
    language: "Shell",
    extensions: [".sh", ".bash"],   // Shell scripts (bash/sh)
    areas: ["env", "filesystem", "security"], // Shell scripts often use env vars, files, and can be security-sensitive
    type: "logic"                    // Scripts are executable logic
  },
  {
    language: "Unknown",
    extensions: [],                  // Fallback — matches any file not recognized above
    areas: [],                       // No default areas — triage may still find dynamic ones
    type: "logic"                    // Assume logic as the safest default
  }
];

/**
 * Detects the language profile for a given file path by matching its extension.
 *
 * Case-insensitive extension matching — `Foo.TS` and `foo.ts` both match TypeScript.
 *
 * @param filePath - Relative or absolute file path (e.g., "src/api/user.ts")
 * @returns The matching LanguageProfile, or the "Unknown" fallback if no match
 */
export function detectLanguage(filePath: string): LanguageProfile {
  // Find the first profile where any of its extensions match the file's extension
  const profile = LANGUAGE_PROFILES.find((item) =>
    item.extensions.some((ext) => filePath.toLowerCase().endsWith(ext))
  );

  // If no extension matches, return the last entry which is the "Unknown" fallback
  return profile ?? LANGUAGE_PROFILES[LANGUAGE_PROFILES.length - 1];
}
