import {
  createProvider,
  openAICompletionsApi,
  type ApiKeyCredential,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findDockerModelRunnerProvider,
  findDockerModelRunnerProviderConfig,
  readDockerModelRunnerProviderConfigs,
} from "./models-json.ts";
import {
  BASE_URL_ENV,
  credentialBaseUrl,
  DEFAULT_BASE_URL,
  discoverDockerModelCatalog,
  discoverModels,
  message,
  PROVIDER_ID,
  normalizeBaseUrl,
  staleModelIds,
} from "./docker-model-runner.ts";

const provider = createProvider({
  id: PROVIDER_ID,
  name: "Docker Model Runner",
  baseUrl: DEFAULT_BASE_URL,
  auth: {
    apiKey: {
      name: "Docker Model Runner connection",
      async login(interaction): Promise<ApiKeyCredential> {
        const connection = await interaction.prompt({
          type: "select",
          message: "Docker Model Runner connection",
          options: [
            {
              id: "local",
              label: "Local Docker Model Runner",
              description: DEFAULT_BASE_URL,
            },
            {
              id: "custom",
              label: "Custom endpoint",
              description: "Remote runner or a non-default local endpoint",
            },
          ],
        });

        const enteredUrl = await interaction.prompt({
          type: "text",
          message:
            connection === "local"
              ? "Docker Model Runner URL"
              : "Docker Model Runner OpenAI base URL",
          placeholder:
            connection === "local"
              ? DEFAULT_BASE_URL
              : "https://runner.example.com/engines/v1",
        });
        const baseUrl = normalizeBaseUrl(
          enteredUrl || (connection === "local" ? DEFAULT_BASE_URL : ""),
        );

        const key = (
          await interaction.prompt({
            type: "secret",
            message:
              "Bearer token (optional; Docker Model Runner itself does not require one)",
            placeholder: "Leave blank for no Authorization header",
          })
        ).trim();

        interaction.notify({
          type: "progress",
          message: "Validating Docker Model Runner and discovering models…",
        });
        const discovery = await discoverDockerModelCatalog(
          baseUrl,
          key || undefined,
          interaction.signal,
        );
        interaction.notify({
          type: "info",
          message: `Connected to Docker Model Runner (${discovery.models.length} model${discovery.models.length === 1 ? "" : "s"} found).`,
        });

        const configured = findDockerModelRunnerProviderConfig(PROVIDER_ID);
        const stale = configured
          ? staleModelIds(configured.staticModelIds, discovery.liveIds)
          : [];
        if (stale.length) {
          interaction.notify({
            type: "info",
            message: `Configured static model${stale.length === 1 ? "" : "s"} not currently reported by Docker: ${stale.join(", ")}`,
          });
        }

        return {
          type: "api_key",
          key: key || undefined,
          env: { [BASE_URL_ENV]: baseUrl },
        };
      },
      async check({ credential }) {
        return credentialBaseUrl(credential)
          ? { type: "api_key", source: "stored Docker Model Runner connection" }
          : undefined;
      },
      async resolve({ credential }) {
        const baseUrl = credentialBaseUrl(credential);
        if (!baseUrl) return undefined;
        return {
          // The OpenAI client requires a non-empty key even for local servers.
          // Docker Model Runner ignores Authorization, so this placeholder is
          // harmless and is replaced by a real proxy token when one was saved.
          auth: { apiKey: credential?.key || "not-needed", baseUrl },
          env: { [BASE_URL_ENV]: baseUrl },
          source: "stored Docker Model Runner connection",
        };
      },
    },
  },
  models: [],
  async fetchModels(context) {
    if (
      !context.allowNetwork ||
      context.signal.aborted ||
      context.credential?.type !== "api_key"
    )
      return [];
    const baseUrl = credentialBaseUrl(context.credential);
    if (!baseUrl) return [];
    return discoverModels(baseUrl, context.credential.key, context.signal);
  },
  api: openAICompletionsApi(),
});

type ProviderStatus = {
  id: string;
  name: string;
  configured: boolean;
  baseUrl?: string;
  discoveredCount?: number;
  registryCount: number;
  stale: string[];
  error?: string;
};

function staleStatusMessage(status: ProviderStatus): string | undefined {
  if (!status.stale.length) return undefined;
  return `${status.name} [${status.id}] stale static model${status.stale.length === 1 ? "" : "s"}: ${status.stale.join(", ")}`;
}

function statusLine(status: ProviderStatus): string {
  return status.error
    ? `${formatProviderLine(status)} — discovery error: ${status.error}`
    : formatProviderLine(status);
}

type ResolvedProviderAuth = {
  auth?: {
    apiKey?: string;
    baseUrl?: string;
  };
  env?: Record<string, string>;
};

type ModelRegistryLike = {
  getProviderAuth(
    providerId: string,
  ): Promise<ResolvedProviderAuth | undefined>;
  getProviderDisplayName(providerId: string): string;
  getAll(): Array<{ provider: string }>;
  getProviderAuthStatus(providerId: string): { configured: boolean };
};

function activeSignal(signal?: AbortSignal): AbortSignal {
  return signal ?? new AbortController().signal;
}

function dockerProviderIds(): string[] {
  return [
    ...new Set([
      PROVIDER_ID,
      ...readDockerModelRunnerProviderConfigs().map(
        (configured) => configured.id,
      ),
    ]),
  ];
}

async function resolveProviderConnection(
  providerId: string,
  modelRegistry: ModelRegistryLike,
): Promise<{ baseUrl?: string; apiKey?: string }> {
  const auth = await modelRegistry
    .getProviderAuth(providerId)
    .catch(() => undefined);
  const configured = findDockerModelRunnerProviderConfig(providerId);
  return {
    apiKey: auth?.auth?.apiKey,
    baseUrl:
      auth?.auth?.baseUrl ??
      (typeof auth?.env?.[BASE_URL_ENV] === "string"
        ? auth.env[BASE_URL_ENV]
        : undefined) ??
      configured?.baseUrl,
  };
}

async function inspectProvider(
  providerId: string,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
): Promise<ProviderStatus> {
  const configured = findDockerModelRunnerProviderConfig(providerId);
  const displayName =
    configured?.name ?? modelRegistry.getProviderDisplayName(providerId);
  const registryCount = modelRegistry
    .getAll()
    .filter((model) => model.provider === providerId).length;
  const authStatus = modelRegistry.getProviderAuthStatus(providerId);
  const connection = await resolveProviderConnection(providerId, modelRegistry);

  if (!connection.baseUrl) {
    return {
      id: providerId,
      name: displayName,
      configured: authStatus.configured || Boolean(configured),
      registryCount,
      stale: [],
    };
  }

  try {
    const discovery = await discoverDockerModelCatalog(
      connection.baseUrl,
      connection.apiKey,
      activeSignal(signal),
      providerId,
    );
    return {
      id: providerId,
      name: displayName,
      configured: authStatus.configured || Boolean(configured),
      baseUrl: connection.baseUrl,
      discoveredCount: discovery.models.length,
      registryCount,
      stale: configured
        ? staleModelIds(configured.staticModelIds, discovery.liveIds)
        : [],
    };
  } catch (error) {
    return {
      id: providerId,
      name: displayName,
      configured: authStatus.configured || Boolean(configured),
      baseUrl: connection.baseUrl,
      registryCount,
      stale: [],
      error: message(error),
    };
  }
}

function formatProviderLine(status: ProviderStatus): string {
  const discovered =
    status.discoveredCount === undefined
      ? "catalog unknown"
      : `${status.discoveredCount} live`;
  return `${status.name} [${status.id}] — ${discovered}, ${status.registryCount} registered${status.baseUrl ? `, ${status.baseUrl}` : ""}`;
}

export default function dockerModelRunnerExtension(pi: ExtensionAPI) {
  pi.registerProvider(provider);

  // A models.json provider can use any ID (for example "dmr-office" or
  // "dmr-lab"). When its baseUrl is a Docker Model Runner /engines/.../v1
  // endpoint, attach dynamic discovery while leaving every user-specified
  // models.json setting as the top-level override.
  for (const configured of readDockerModelRunnerProviderConfigs()) {
    if (configured.id === PROVIDER_ID) continue; // reserved for /login support
    pi.registerProvider(configured.id, {
      refreshModels: async (context) => {
        if (!context.allowNetwork || context.signal.aborted) return [];
        const current = findDockerModelRunnerProvider(configured.id);
        if (!current) return [];
        const key =
          context.credential?.type === "api_key"
            ? context.credential.key
            : undefined;
        return discoverModels(
          current.baseUrl,
          key,
          context.signal,
          configured.id,
        );
      },
    });
  }

  pi.registerCommand("docker-model-runner", {
    description: "Show Docker Model Runner status or refresh its model catalog",
    getArgumentCompletions: (prefix) => {
      const commands = ["status", "refresh"];
      const matches = commands.filter((command) => command.startsWith(prefix));
      return matches.length
        ? matches.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command !== "status" && command !== "refresh") {
        ctx.ui.notify("Usage: /docker-model-runner [status|refresh]", "error");
        return;
      }

      const providerIds = dockerProviderIds();

      if (command === "refresh") {
        const result = await ctx.modelRegistry.refresh({
          providers: providerIds,
          force: true,
        });
        const errors = providerIds
          .map(
            (providerId) =>
              [providerId, result.errors.get(providerId)] as const,
          )
          .filter(
            (entry): entry is readonly [string, Error] =>
              entry[1] !== undefined,
          );
        if (errors.length) {
          ctx.ui.notify(
            `Docker Model Runner refresh failed: ${errors.map(([providerId, error]) => `${providerId}: ${message(error)}`).join("; ")}`,
            "error",
          );
          return;
        }

        const statuses = await Promise.all(
          providerIds.map((providerId) =>
            inspectProvider(providerId, ctx.modelRegistry, ctx.signal),
          ),
        );
        const total = statuses.reduce(
          (sum, status) => sum + status.registryCount,
          0,
        );
        ctx.ui.notify(
          `Docker Model Runner refreshed: ${total} model${total === 1 ? "" : "s"} available across ${statuses.length} provider${statuses.length === 1 ? "" : "s"}.`,
          "info",
        );

        const stale = statuses
          .map(staleStatusMessage)
          .filter((value): value is string => value !== undefined);
        if (stale.length) ctx.ui.notify(stale.join("\n"), "warning");
        return;
      }

      const statuses = await Promise.all(
        providerIds.map((providerId) =>
          inspectProvider(providerId, ctx.modelRegistry, ctx.signal),
        ),
      );
      const configuredStatuses = statuses.filter((status) => status.configured);
      if (!configuredStatuses.length) {
        ctx.ui.notify(
          "Docker Model Runner is not configured. Run /login docker-model-runner or add a Docker-backed provider to models.json.",
          "warning",
        );
        return;
      }

      const lines = configuredStatuses.map(statusLine);
      ctx.ui.notify(lines.join("\n"), "info");

      const stale = configuredStatuses
        .map(staleStatusMessage)
        .filter((value): value is string => value !== undefined);
      if (stale.length) ctx.ui.notify(stale.join("\n"), "warning");
    },
  });
}
