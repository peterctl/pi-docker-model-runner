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
  models?: unknown;
};

type ModelEntry = {
  id?: unknown;
};

export type DockerModelRunnerModelsJsonProvider = {
  id: string;
  name?: string;
  baseUrl: string;
};

export type DockerModelRunnerModelsJsonProviderConfig =
  DockerModelRunnerModelsJsonProvider & {
    staticModelIds: string[];
  };

export function modelsJsonPath(): string {
  return join(
    process.env.PI_AGENT_DIR || homedir(),
    process.env.PI_AGENT_DIR ? "models.json" : ".pi/agent/models.json",
  );
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

function parseStaticModelIds(models: unknown): string[] {
  if (!Array.isArray(models)) return [];

  const ids = new Set<string>();
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const id = (item as ModelEntry).id;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }

  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Read only DMR-looking providers from pi's user-owned models.json.
 * models.json remains the source of truth for provider names, auth, and model
 * metadata; this package only attaches discovery/refresh behavior to them.
 */
export function readDockerModelRunnerProviderConfigs(
  path = modelsJsonPath(),
): DockerModelRunnerModelsJsonProviderConfig[] {
  if (!existsSync(path)) return [];

  let parsed: ModelsJson;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ModelsJson;
  } catch {
    return [];
  }
  if (!parsed.providers || typeof parsed.providers !== "object") return [];

  const providers: DockerModelRunnerModelsJsonProviderConfig[] = [];
  for (const [id, value] of Object.entries(parsed.providers)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as ProviderEntry;
    if (
      typeof entry.baseUrl !== "string" ||
      !isDockerModelRunnerBaseUrl(entry.baseUrl)
    )
      continue;
    providers.push({
      id,
      name: typeof entry.name === "string" ? entry.name : undefined,
      baseUrl: normalizeBaseUrl(entry.baseUrl),
      staticModelIds: parseStaticModelIds(entry.models),
    });
  }
  return providers;
}

export function readDockerModelRunnerProviders(
  path = modelsJsonPath(),
): DockerModelRunnerModelsJsonProvider[] {
  return readDockerModelRunnerProviderConfigs(path).map(
    ({ staticModelIds: _staticModelIds, ...provider }) => provider,
  );
}

export function findDockerModelRunnerProvider(
  id: string,
): DockerModelRunnerModelsJsonProvider | undefined {
  return readDockerModelRunnerProviders().find(
    (provider) => provider.id === id,
  );
}

export function findDockerModelRunnerProviderConfig(
  id: string,
): DockerModelRunnerModelsJsonProviderConfig | undefined {
  return readDockerModelRunnerProviderConfigs().find(
    (provider) => provider.id === id,
  );
}
