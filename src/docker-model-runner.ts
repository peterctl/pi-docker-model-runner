import type { Model } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "docker-model-runner";
export const DEFAULT_BASE_URL = "http://localhost:12434/engines/v1";
export const BASE_URL_ENV = "DOCKER_MODEL_RUNNER_BASE_URL";
export type DockerModelRunnerCredentialEnv = Record<
  typeof BASE_URL_ENV,
  string
>;

type JsonPrimitive = string | number | boolean | null;
interface JsonObject {
  [key: string]: JsonValue | undefined;
}
interface JsonArray extends Array<JsonValue> {}
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type ModelsPayload = {
  data?: JsonValue;
};

type DiscoveredDockerModelMetadata = {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  compat?: Model<"openai-completions">["compat"];
};

export type DiscoveredDockerModel = DiscoveredDockerModelMetadata & {
  id: string;
  provider: string;
  baseUrl: string;
  sources: string[];
};

export type DockerModelDiscovery = {
  models: Model<"openai-completions">[];
  discovered: DiscoveredDockerModel[];
  liveIds: string[];
};

const DEFAULT_INPUT: ("text" | "image")[] = ["text"];
const DEFAULT_COMPAT: NonNullable<Model<"openai-completions">["compat"]> = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
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
    throw new Error(
      "Docker Model Runner URLs must not include a query string or fragment.",
    );
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

export function modelUrl(baseUrl: string, modelId: string): string | undefined {
  const path = modelIdPath(modelId);
  return path ? `${normalizeBaseUrl(baseUrl)}/models/${path}` : undefined;
}

export function nativeModelsUrl(baseUrl: string): string {
  return `${runnerRootUrl(baseUrl)}/models`;
}

export function nativeModelUrl(
  baseUrl: string,
  modelId: string,
): string | undefined {
  const path = modelIdPath(modelId);
  return path ? `${nativeModelsUrl(baseUrl)}/${path}` : undefined;
}

export function ollamaShowUrl(baseUrl: string): string {
  return `${runnerRootUrl(baseUrl)}/api/show`;
}

export function credentialBaseUrl(credential?: {
  env?: Record<string, string>;
}): string | undefined {
  const value = credential?.env?.[BASE_URL_ENV]?.trim();
  return value ? normalizeBaseUrl(value) : undefined;
}

function runnerRootUrl(baseUrl: string): string {
  try {
    const url = new URL(normalizeBaseUrl(baseUrl));
    url.pathname =
      url.pathname.replace(/^\/engines(?:\/[^/]+)?\/v1$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return normalizeBaseUrl(baseUrl);
  }
}

function modelIdPath(modelId: string): string | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  const namespace = trimmed.slice(0, slash);
  const name = trimmed.slice(slash + 1);
  return `${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

function requestHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Docker Model Runner ignores Authorization. Sending it only when supplied
  // keeps the custom endpoint path usable behind an authenticating proxy.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchRequiredJson(
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  init?: RequestInit,
): Promise<JsonValue> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...requestHeaders(apiKey),
        ...(init?.headers
          ? Object.fromEntries(new Headers(init.headers).entries())
          : {}),
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      `Could not reach Docker Model Runner at ${url}: ${message(error)}`,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    const detail = body.trim();
    throw new Error(
      `Docker Model Runner model discovery failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  try {
    return JSON.parse(body) as JsonValue;
  } catch {
    throw new Error(
      "Docker Model Runner returned invalid JSON from its discovery endpoint.",
    );
  }
}

async function fetchOptionalJson(
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  init?: RequestInit,
): Promise<JsonValue | undefined> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...requestHeaders(apiKey),
        ...(init?.headers
          ? Object.fromEntries(new Headers(init.headers).entries())
          : {}),
      },
      signal,
    });
  } catch {
    return undefined;
  }

  if (
    response.status === 404 ||
    response.status === 405 ||
    response.status === 501
  )
    return undefined;
  if (!response.ok) return undefined;

  try {
    return JSON.parse(await response.text()) as JsonValue;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function getPath(
  value: JsonValue | undefined,
  path: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim()))
    return Number.parseInt(value.trim(), 10);
  return undefined;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = toPositiveInteger(value);
    if (parsed && parsed > 0) return parsed;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function extractInput(value: unknown): ("text" | "image")[] | undefined {
  const inputs = new Set<"text" | "image">();
  const visit = (entry: unknown) => {
    if (typeof entry !== "string") return;
    const normalized = entry.trim().toLowerCase();
    if (normalized === "text") inputs.add("text");
    if (normalized === "image") inputs.add("image");
  };

  if (Array.isArray(value)) {
    for (const item of value) visit(item);
  } else {
    visit(value);
  }

  return inputs.size ? [...inputs] : undefined;
}

function mergeCompat(
  ...values: Array<Model<"openai-completions">["compat"] | undefined>
): Model<"openai-completions">["compat"] | undefined {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
}

function mergeMetadata(
  base: DiscoveredDockerModelMetadata,
  extra: DiscoveredDockerModelMetadata,
): DiscoveredDockerModelMetadata {
  return {
    name: extra.name ?? base.name,
    contextWindow: extra.contextWindow ?? base.contextWindow,
    maxTokens: extra.maxTokens ?? base.maxTokens,
    reasoning: extra.reasoning ?? base.reasoning,
    input: extra.input ?? base.input,
    compat: mergeCompat(base.compat, extra.compat),
  };
}

function extractCompat(
  payload: JsonValue | undefined,
): Model<"openai-completions">["compat"] | undefined {
  const maxTokensField = firstString(
    getPath(payload, ["compat", "maxTokensField"]),
    getPath(payload, ["compat", "max_tokens_field"]),
    getPath(payload, ["dmr", "max_tokens_field"]),
    getPath(payload, ["max_tokens_field"]),
  );

  const compat: NonNullable<Model<"openai-completions">["compat"]> = {};
  const supportsDeveloperRole = firstBoolean(
    getPath(payload, ["compat", "supportsDeveloperRole"]),
    getPath(payload, ["compat", "supports_developer_role"]),
    getPath(payload, ["capabilities", "supportsDeveloperRole"]),
    getPath(payload, ["capabilities", "supports_developer_role"]),
  );
  if (supportsDeveloperRole !== undefined)
    compat.supportsDeveloperRole = supportsDeveloperRole;

  const supportsReasoningEffort = firstBoolean(
    getPath(payload, ["compat", "supportsReasoningEffort"]),
    getPath(payload, ["compat", "supports_reasoning_effort"]),
    getPath(payload, ["capabilities", "supportsReasoningEffort"]),
    getPath(payload, ["capabilities", "supports_reasoning_effort"]),
  );
  if (supportsReasoningEffort !== undefined)
    compat.supportsReasoningEffort = supportsReasoningEffort;

  const supportsStrictMode = firstBoolean(
    getPath(payload, ["compat", "supportsStrictMode"]),
    getPath(payload, ["compat", "supports_strict_mode"]),
    getPath(payload, ["capabilities", "supportsStrictMode"]),
    getPath(payload, ["capabilities", "supports_strict_mode"]),
  );
  if (supportsStrictMode !== undefined)
    compat.supportsStrictMode = supportsStrictMode;

  if (
    maxTokensField === "max_tokens" ||
    maxTokensField === "max_completion_tokens"
  ) {
    compat.maxTokensField = maxTokensField;
  }

  return Object.keys(compat).length ? compat : undefined;
}

function extractModelMetadata(
  payload: JsonValue | undefined,
): DiscoveredDockerModelMetadata {
  const name = firstString(
    getPath(payload, ["name"]),
    getPath(payload, ["display_name"]),
    getPath(payload, ["displayName"]),
    getPath(payload, ["title"]),
  );

  const contextWindow = firstPositiveInteger(
    getPath(payload, ["config", "context_size"]),
    getPath(payload, ["config", "context_window"]),
    getPath(payload, ["config", "contextWindow"]),
    getPath(payload, ["runtime", "context_size"]),
    getPath(payload, ["runtime", "context_window"]),
    getPath(payload, ["runtime", "contextWindow"]),
    getPath(payload, ["settings", "context_size"]),
    getPath(payload, ["settings", "context_window"]),
    getPath(payload, ["settings", "contextWindow"]),
    getPath(payload, ["options", "num_ctx"]),
    getPath(payload, ["options", "context_size"]),
    getPath(payload, ["options", "context_window"]),
    getPath(payload, ["options", "contextWindow"]),
    getPath(payload, ["dmr", "context_size"]),
    getPath(payload, ["dmr", "context_window"]),
    getPath(payload, ["dmr", "contextWindow"]),
    getPath(payload, ["context_size"]),
    getPath(payload, ["context_window"]),
    getPath(payload, ["contextWindow"]),
    getPath(payload, ["context_length"]),
  );

  const maxTokens = firstPositiveInteger(
    getPath(payload, ["config", "max_tokens"]),
    getPath(payload, ["config", "max_output_tokens"]),
    getPath(payload, ["config", "num_predict"]),
    getPath(payload, ["runtime", "max_tokens"]),
    getPath(payload, ["runtime", "max_output_tokens"]),
    getPath(payload, ["runtime", "num_predict"]),
    getPath(payload, ["settings", "max_tokens"]),
    getPath(payload, ["settings", "max_output_tokens"]),
    getPath(payload, ["settings", "num_predict"]),
    getPath(payload, ["options", "max_tokens"]),
    getPath(payload, ["options", "max_output_tokens"]),
    getPath(payload, ["options", "num_predict"]),
    getPath(payload, ["dmr", "max_tokens"]),
    getPath(payload, ["dmr", "max_output_tokens"]),
    getPath(payload, ["max_tokens"]),
    getPath(payload, ["max_output_tokens"]),
  );

  const reasoning = firstBoolean(
    getPath(payload, ["reasoning"]),
    getPath(payload, ["supports_reasoning"]),
    getPath(payload, ["supportsReasoning"]),
    getPath(payload, ["capabilities", "reasoning"]),
    getPath(payload, ["capabilities", "supports_reasoning"]),
    getPath(payload, ["capabilities", "supportsReasoning"]),
    getPath(payload, ["dmr", "reasoning"]),
  );

  const input = extractInput(
    getPath(payload, ["input"]) ??
      getPath(payload, ["modalities"]) ??
      getPath(payload, ["capabilities", "input"]) ??
      getPath(payload, ["capabilities", "modalities"]),
  );

  return {
    name,
    contextWindow,
    maxTokens,
    reasoning,
    input,
    compat: extractCompat(payload),
  };
}

async function listModelsFromOpenAIEndpoint(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  provider: string,
): Promise<Map<string, DiscoveredDockerModel>> {
  const payload = await fetchRequiredJson(modelsUrl(baseUrl), apiKey, signal);
  if (!isObject(payload) || !Array.isArray((payload as ModelsPayload).data)) {
    throw new Error(
      "Docker Model Runner returned an invalid OpenAI /models response (missing data array).",
    );
  }

  const discovered = new Map<string, DiscoveredDockerModel>();
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  for (const item of (payload as ModelsPayload).data as unknown[]) {
    if (!isObject(item)) continue;
    const id = firstString(item.id);
    if (!id) continue;
    const previous = discovered.get(id);
    const metadata = extractModelMetadata(item);
    discovered.set(id, {
      id,
      provider,
      baseUrl: normalizedBaseUrl,
      sources: previous ? previous.sources : ["openai-list"],
      ...mergeMetadata(previous ?? {}, metadata),
    });
  }
  return discovered;
}

async function probeSingleModelMetadata(
  baseUrl: string,
  apiKey: string | undefined,
  model: DiscoveredDockerModel,
  signal: AbortSignal,
): Promise<void> {
  const merge = (payload: JsonValue | undefined, source: string) => {
    if (!payload) return;
    const metadata = extractModelMetadata(payload);
    const next = mergeMetadata(model, metadata);
    Object.assign(model, next);
    if (!model.sources.includes(source)) model.sources.push(source);
  };

  const openAiDetail = modelUrl(baseUrl, model.id);
  if (openAiDetail)
    merge(
      await fetchOptionalJson(openAiDetail, apiKey, signal),
      "openai-detail",
    );

  const nativeDetail = nativeModelUrl(baseUrl, model.id);
  if (nativeDetail)
    merge(
      await fetchOptionalJson(nativeDetail, apiKey, signal),
      "native-detail",
    );

  merge(
    await fetchOptionalJson(ollamaShowUrl(baseUrl), apiKey, signal, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.id }),
    }),
    "ollama-show",
  );
}

async function probeDockerModelMetadata(
  baseUrl: string,
  apiKey: string | undefined,
  models: Map<string, DiscoveredDockerModel>,
  signal: AbortSignal,
): Promise<void> {
  await Promise.all(
    [...models.values()].map((model) =>
      probeSingleModelMetadata(baseUrl, apiKey, model, signal),
    ),
  );
}

function toPiModel(
  discovered: DiscoveredDockerModel,
): Model<"openai-completions"> {
  return {
    id: discovered.id,
    name: discovered.name ?? discovered.id,
    api: "openai-completions",
    provider: discovered.provider,
    baseUrl: discovered.baseUrl,
    reasoning: discovered.reasoning ?? false,
    input: discovered.input ?? DEFAULT_INPUT,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: discovered.contextWindow ?? 2048,
    maxTokens: discovered.maxTokens ?? 1024,
    compat: { ...DEFAULT_COMPAT, ...(discovered.compat ?? {}) },
  };
}

export async function discoverDockerModelCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  provider = PROVIDER_ID,
): Promise<DockerModelDiscovery> {
  const discovered = await listModelsFromOpenAIEndpoint(
    baseUrl,
    apiKey,
    signal,
    provider,
  );
  await probeDockerModelMetadata(baseUrl, apiKey, discovered, signal);

  const models = [...discovered.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((model) => toPiModel(model));

  return {
    models,
    discovered: [...discovered.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    liveIds: [...discovered.keys()].sort((a, b) => a.localeCompare(b)),
  };
}

/** Query the OpenAI-compatible discovery endpoint used by Docker Model Runner. */
export async function discoverModels(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  provider = PROVIDER_ID,
): Promise<Model<"openai-completions">[]> {
  return (await discoverDockerModelCatalog(baseUrl, apiKey, signal, provider))
    .models;
}

export function staleModelIds(
  staticModelIds: readonly string[],
  liveIds: readonly string[],
): string[] {
  const live = new Set(liveIds);
  return [...new Set(staticModelIds)]
    .filter((id) => !live.has(id))
    .sort((a, b) => a.localeCompare(b));
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
