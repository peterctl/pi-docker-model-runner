import { createProvider, openAICompletionsApi, type ApiKeyCredential } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findDockerModelRunnerProvider, readDockerModelRunnerProviders } from "./models-json.ts";
import {
  BASE_URL_ENV,
  credentialBaseUrl,
  DEFAULT_BASE_URL,
  discoverModels,
  message,
  PROVIDER_ID,
  normalizeBaseUrl,
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
          message: connection === "local" ? "Docker Model Runner URL" : "Docker Model Runner OpenAI base URL",
          placeholder: connection === "local" ? DEFAULT_BASE_URL : "https://runner.example.com/engines/v1",
        });
        const baseUrl = normalizeBaseUrl(enteredUrl || (connection === "local" ? DEFAULT_BASE_URL : ""));

        const key = (await interaction.prompt({
          type: "secret",
          message: "Bearer token (optional; Docker Model Runner itself does not require one)",
          placeholder: "Leave blank for no Authorization header",
        })).trim();

        interaction.notify({ type: "progress", message: "Validating Docker Model Runner and discovering models…" });
        const models = await discoverModels(baseUrl, key || undefined, interaction.signal);
        interaction.notify({
          type: "info",
          message: `Connected to Docker Model Runner (${models.length} model${models.length === 1 ? "" : "s"} found).`,
        });

        return {
          type: "api_key",
          key: key || undefined,
          env: { [BASE_URL_ENV]: baseUrl },
        };
      },
      async check({ credential }) {
        return credentialBaseUrl(credential) ? { type: "api_key", source: "stored Docker Model Runner connection" } : undefined;
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
    if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return [];
    const baseUrl = credentialBaseUrl(context.credential);
    if (!baseUrl) return [];
    return discoverModels(baseUrl, context.credential.key, context.signal);
  },
  api: openAICompletionsApi(),
});

export default function dockerModelRunnerExtension(pi: ExtensionAPI) {
  pi.registerProvider(provider);

  // A models.json provider can use any ID (for example "dmr-office" or
  // "dmr-lab"). When its baseUrl is a Docker Model Runner /engines/.../v1
  // endpoint, attach dynamic discovery while leaving every user-specified
  // models.json setting as the top-level override.
  for (const configured of readDockerModelRunnerProviders()) {
    if (configured.id === PROVIDER_ID) continue; // reserved for /login support
    pi.registerProvider(configured.id, {
      refreshModels: async (context) => {
        if (!context.allowNetwork || context.signal.aborted) return [];
        const current = findDockerModelRunnerProvider(configured.id);
        if (!current) return [];
        const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
        return discoverModels(current.baseUrl, key, context.signal, configured.id);
      },
    });
  }

  pi.registerCommand("docker-model-runner", {
    description: "Show Docker Model Runner status or refresh its model catalog",
    getArgumentCompletions: (prefix) => {
      const commands = ["status", "refresh"];
      const matches = commands.filter((command) => command.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command !== "status" && command !== "refresh") {
        ctx.ui.notify("Usage: /docker-model-runner [status|refresh]", "error");
        return;
      }

      if (command === "refresh") {
        const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
        const error = result.errors.get(PROVIDER_ID);
        if (error) {
          ctx.ui.notify(`Docker Model Runner refresh failed: ${message(error)}`, "error");
          return;
        }
        const count = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).length;
        ctx.ui.notify(`Docker Model Runner refreshed: ${count} model${count === 1 ? "" : "s"} available.`, "info");
        return;
      }

      const auth = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
      if (!auth.configured) {
        ctx.ui.notify("Docker Model Runner is not configured. Run /login docker-model-runner.", "warning");
        return;
      }
      const count = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).length;
      ctx.ui.notify(`Docker Model Runner is configured; ${count} discovered model${count === 1 ? "" : "s"}.`, "info");
    },
  });
}
