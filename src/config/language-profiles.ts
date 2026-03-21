import type { LanguageProfile } from "../types.js";

export const LANGUAGE_PROFILES: LanguageProfile[] = [
  {
    language: "TypeScript",
    extensions: [".ts", ".tsx"],
    areas: ["api", "async", "validation", "env"],
    type: "logic"
  },
  {
    language: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    areas: ["api", "async", "validation", "env"],
    type: "logic"
  },
  {
    language: "Stylesheet",
    extensions: [".css", ".scss", ".sass", ".less"],
    areas: ["ui", "config"],
    type: "logic"
  },
  {
    language: "Python",
    extensions: [".py"],
    areas: ["api", "db", "validation", "filesystem", "crypto"],
    type: "logic"
  },
  {
    language: "Java",
    extensions: [".java"],
    areas: ["api", "db", "validation", "auth", "config"],
    type: "logic"
  },
  {
    language: "Kotlin",
    extensions: [".kt"],
    areas: ["api", "db", "validation", "auth", "config"],
    type: "logic"
  },
  {
    language: "JSON",
    extensions: [".json"],
    areas: ["config", "dependency"],
    type: "config"
  },
  {
    language: "YAML",
    extensions: [".yml", ".yaml"],
    areas: ["config", "env", "dependency"],
    type: "config"
  },
  {
    language: "XML",
    extensions: [".xml"],
    areas: ["config", "dependency"],
    type: "config"
  },
  {
    language: "Gradle",
    extensions: [".gradle"],
    areas: ["config", "dependency"],
    type: "dependency"
  },
  {
    language: "Maven",
    extensions: [".pom"],
    areas: ["config", "dependency"],
    type: "dependency"
  },
  {
    language: "Properties",
    extensions: [".properties"],
    areas: ["config", "env"],
    type: "config"
  },
  {
    language: "Shell",
    extensions: [".sh", ".bash"],
    areas: ["env", "filesystem", "security"],
    type: "logic"
  },
  {
    language: "Unknown",
    extensions: [],
    areas: [],
    type: "logic"
  }
];

export function detectLanguage(filePath: string): LanguageProfile {
  const profile = LANGUAGE_PROFILES.find((item) =>
    item.extensions.some((ext) => filePath.toLowerCase().endsWith(ext))
  );

  return profile ?? LANGUAGE_PROFILES[LANGUAGE_PROFILES.length - 1];
}

