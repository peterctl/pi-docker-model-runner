import type { Model } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "docker-model-runner";
export const DEFAULT_BASE_URL = "http://localhost:12434/engines/v1";
export const BASE_URL_ENV = "DOCKER_MODEL_RUNNER_BASE_URL";
export type DockerModelRunnerCredentialEnv = Record<typeof BASE_URL_ENV, string>;

type ModelsPayload = {
  data?: unknown;
};


/**
 * Normalize a Docker Model Runner OpenAI API URL.
 *
 * A bare Docker Model Runner host is expanded to its documented OpenAI
 * compatibility endpoint. Engine-qualified paths are retained, allowing a
 * user to target a specific engine such as /engines/llama.cpp/v1.
 */
export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return DEFAULT_BASE_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Docker Model Runner URLs must use http: or https:.");
  }
  if (url.username || url.password) {
    throw new Error("Docker Model Runner URLs must not include credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Docker Model Runner URLs must not include a query string or fragment.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/" || path === "/engines") {
    url.pathname = "/engines/v1";
  } else {
    url.pathname = path;
  }
  return url.toString().replace(/\/$/, "");
}

export function modelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

export function credentialBaseUrl(credential?: { env?: Record<string, string> }): string | undefined {
  const value = credential?.env?.[BASE_URL_ENV]?.trim();
  return value ? normalizeBaseUrl(value) : undefined;
}

/** Query the OpenAI-compatible discovery endpoint used by Docker Model Runner. */
export async function discoverModels(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  provider = PROVIDER_ID,
): Promise<Model<"openai-completions">[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Docker Model Runner ignores Authorization. Sending it only when supplied
  // keeps the custom endpoint path usable behind an authenticating proxy.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(modelsUrl(baseUrl), { headers, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`Could not reach Docker Model Runner at ${modelsUrl(baseUrl)}: ${message(error)}`);
  }

  const body = await response.text();
  if (!response.ok) {
    const detail = body.trim();
    throw new Error(
      `Docker Model Runner model discovery failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  let payload: ModelsPayload;
  try {
    payload = JSON.parse(body) as ModelsPayload;
  } catch {
    throw new Error("Docker Model Runner returned invalid JSON from its OpenAI /models endpoint.");
  }
  if (!Array.isArray(payload.data)) {
    throw new Error("Docker Model Runner returned an invalid OpenAI /models response (missing data array).");
  }

  const ids = new Set<string>();
  for (const item of payload.data) {
    if (typeof item !== "object" || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  return [...ids].sort((a, b) => a.localeCompare(b)).map((id) => ({
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: normalizedBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // dmr.context_window is the model's trained maximum, not the runner's
    // effective configured context size. Do not advertise it as usable here.
    // models.json is the source of truth for a runner's configured limit.
    contextWindow: 2048,
    maxTokens: 1024,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  }));
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
