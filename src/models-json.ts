import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeBaseUrl } from "./docker-model-runner.ts";

type ModelsJson = {
  providers?: Record<string, unknown>;
};

type ProviderEntry = {
  name?: unknown;
  baseUrl?: unknown;
};

export type DockerModelRunnerModelsJsonProvider = {
  id: string;
  name?: string;
  baseUrl: string;
};

export function modelsJsonPath(): string {
  return join(process.env.PI_AGENT_DIR || homedir(), process.env.PI_AGENT_DIR ? "models.json" : ".pi/agent/models.json");
}

/** Docker Model Runner's OpenAI API always lives below /engines/.../v1. */
export function isDockerModelRunnerBaseUrl(value: string): boolean {
  try {
    const url = new URL(normalizeBaseUrl(value));
    return /^\/engines(?:\/[^/]+)?\/v1$/.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Read only DMR-looking providers from pi's user-owned models.json.
 * models.json remains the source of truth for provider names, auth, and model
 * metadata; this package only attaches discovery/refresh behavior to them.
 */
export function readDockerModelRunnerProviders(path = modelsJsonPath()): DockerModelRunnerModelsJsonProvider[] {
  if (!existsSync(path)) return [];

  let parsed: ModelsJson;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ModelsJson;
  } catch {
    return [];
  }
  if (!parsed.providers || typeof parsed.providers !== "object") return [];

  const providers: DockerModelRunnerModelsJsonProvider[] = [];
  for (const [id, value] of Object.entries(parsed.providers)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as ProviderEntry;
    if (typeof entry.baseUrl !== "string" || !isDockerModelRunnerBaseUrl(entry.baseUrl)) continue;
    providers.push({
      id,
      name: typeof entry.name === "string" ? entry.name : undefined,
      baseUrl: normalizeBaseUrl(entry.baseUrl),
    });
  }
  return providers;
}

export function findDockerModelRunnerProvider(id: string): DockerModelRunnerModelsJsonProvider | undefined {
  return readDockerModelRunnerProviders().find((provider) => provider.id === id);
}
