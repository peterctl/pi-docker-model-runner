import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_BASE_URL,
  discoverModels,
  modelUrl,
  modelsUrl,
  nativeModelUrl,
  normalizeBaseUrl,
  ollamaShowUrl,
  staleModelIds,
} from "../src/docker-model-runner.ts";
import {
  isDockerModelRunnerBaseUrl,
  readDockerModelRunnerProviderConfigs,
  readDockerModelRunnerProviders,
} from "../src/models-json.ts";

test("uses Docker Model Runner's documented OpenAI endpoint by default", () => {
  assert.equal(normalizeBaseUrl(""), DEFAULT_BASE_URL);
  assert.equal(
    modelsUrl("http://localhost:12434"),
    "http://localhost:12434/engines/v1/models",
  );
  assert.equal(
    modelUrl("http://localhost:12434", "ai/qwen"),
    "http://localhost:12434/engines/v1/models/ai/qwen",
  );
  assert.equal(
    nativeModelUrl("http://localhost:12434", "ai/qwen"),
    "http://localhost:12434/models/ai/qwen",
  );
  assert.equal(
    ollamaShowUrl("http://localhost:12434"),
    "http://localhost:12434/api/show",
  );
});

test("preserves OpenAI and engine-qualified base paths", () => {
  assert.equal(
    normalizeBaseUrl("http://localhost:12434/engines/v1/"),
    "http://localhost:12434/engines/v1",
  );
  assert.equal(
    normalizeBaseUrl("https://runner.example.com/engines/llama.cpp/v1"),
    "https://runner.example.com/engines/llama.cpp/v1",
  );
  assert.equal(
    nativeModelUrl(
      "https://runner.example.com/engines/llama.cpp/v1",
      "ai/qwen2.5-coder",
    ),
    "https://runner.example.com/models/ai/qwen2.5-coder",
  );
});

test("discovers model settings from documented Docker metadata endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    method: string;
    authorization: string | null;
  }> = [];

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
    });

    if (request.url === `${DEFAULT_BASE_URL}/models`) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "ai/qwen",
              name: "Qwen list",
              dmr: { context_window: 32768 },
            },
            { id: "ai/qwen" },
            {},
            { id: 4 },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (request.url === `${DEFAULT_BASE_URL}/models/ai/qwen`) {
      return new Response(
        JSON.stringify({
          id: "ai/qwen",
          name: "Qwen detail",
          config: { context_size: 8192, max_tokens: 2048 },
          reasoning: true,
          input: ["text", "image"],
          compat: { supportsStrictMode: true },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (request.url === "http://localhost:12434/models/ai/qwen") {
      return new Response(
        JSON.stringify({
          display_name: "Qwen native",
          options: { num_ctx: 16384, num_predict: 4096 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (request.url === "http://localhost:12434/api/show") {
      return new Response(
        JSON.stringify({
          name: "Qwen show",
          options: { num_ctx: 12288, num_predict: 3072 },
          compat: {
            supportsDeveloperRole: true,
            maxTokensField: "max_completion_tokens",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response("not found", { status: 404 });
  };

  try {
    const models = await discoverModels(
      "http://localhost:12434",
      "proxy-token",
      new AbortController().signal,
    );
    assert.deepEqual(
      models.map((model) => model.id),
      ["ai/qwen"],
    );
    assert.equal(models[0]?.baseUrl, DEFAULT_BASE_URL);
    assert.equal(models[0]?.name, "Qwen show");
    assert.equal(models[0]?.contextWindow, 12288);
    assert.equal(models[0]?.maxTokens, 3072);
    assert.equal(models[0]?.reasoning, true);
    assert.deepEqual(models[0]?.input, ["text", "image"]);
    assert.deepEqual(models[0]?.compat, {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      supportsStrictMode: true,
      maxTokensField: "max_completion_tokens",
    });
    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      [
        `GET ${DEFAULT_BASE_URL}/models`,
        `GET ${DEFAULT_BASE_URL}/models/ai/qwen`,
        "GET http://localhost:12434/models/ai/qwen",
        "POST http://localhost:12434/api/show",
      ],
    );
    assert.deepEqual(
      [...new Set(requests.map((request) => request.authorization))],
      ["Bearer proxy-token"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back conservatively when Docker omits settings", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === `${DEFAULT_BASE_URL}/models`) {
      return new Response(JSON.stringify({ data: [{ id: "ai/qwen" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const models = await discoverModels(
      "http://localhost:12434",
      undefined,
      new AbortController().signal,
    );
    assert.equal(models[0]?.contextWindow, 2048);
    assert.equal(models[0]?.maxTokens, 1024);
    assert.equal(models[0]?.reasoning, false);
    assert.deepEqual(models[0]?.input, ["text"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Docker-exposed list fields before conservative fallbacks when probes are unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === `${DEFAULT_BASE_URL}/models`) {
      return new Response(
        JSON.stringify({
          data: [{ id: "ai/qwen", dmr: { context_window: 32768 } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const models = await discoverModels(
      "http://localhost:12434",
      undefined,
      new AbortController().signal,
    );
    assert.equal(models[0]?.contextWindow, 32768);
    assert.equal(models[0]?.maxTokens, 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ignores malformed optional metadata payloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === `${DEFAULT_BASE_URL}/models`) {
      return new Response(JSON.stringify({ data: [{ id: "ai/qwen" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (
      url === `${DEFAULT_BASE_URL}/models/ai/qwen` ||
      url === "http://localhost:12434/models/ai/qwen" ||
      url === "http://localhost:12434/api/show"
    ) {
      return new Response("definitely not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const models = await discoverModels(
      "http://localhost:12434",
      undefined,
      new AbortController().signal,
    );
    assert.equal(models[0]?.contextWindow, 2048);
    assert.equal(models[0]?.maxTokens, 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finds arbitrary Docker Model Runner provider IDs and static models in models.json", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-dmr-")), "models.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        "dmr-lab": {
          name: "Lab runner",
          baseUrl: "https://lab.example.com/engines/v1",
          models: [{ id: "ai/qwen" }, { id: "ai/deepseek" }, { id: "ai/qwen" }],
        },
        "dmr-llama": { baseUrl: "http://localhost:12434/engines/llama.cpp/v1" },
        unrelated: { baseUrl: "http://localhost:11434/v1" },
      },
    }),
  );

  assert.equal(
    isDockerModelRunnerBaseUrl("http://localhost:12434/engines/v1"),
    true,
  );
  assert.equal(isDockerModelRunnerBaseUrl("http://localhost:11434/v1"), false);
  assert.deepEqual(readDockerModelRunnerProviders(path), [
    {
      id: "dmr-lab",
      name: "Lab runner",
      baseUrl: "https://lab.example.com/engines/v1",
    },
    {
      id: "dmr-llama",
      name: undefined,
      baseUrl: "http://localhost:12434/engines/llama.cpp/v1",
    },
  ]);
  assert.deepEqual(readDockerModelRunnerProviderConfigs(path), [
    {
      id: "dmr-lab",
      name: "Lab runner",
      baseUrl: "https://lab.example.com/engines/v1",
      staticModelIds: ["ai/deepseek", "ai/qwen"],
    },
    {
      id: "dmr-llama",
      name: undefined,
      baseUrl: "http://localhost:12434/engines/llama.cpp/v1",
      staticModelIds: [],
    },
  ]);
});

test("detects stale static models", () => {
  assert.deepEqual(
    staleModelIds(["ai/qwen", "ai/deepseek", "ai/qwen"], ["ai/qwen"]),
    ["ai/deepseek"],
  );
});

test("rejects unsafe or malformed endpoint URLs", () => {
  assert.throws(
    () => normalizeBaseUrl("runner.example.com"),
    /valid HTTP\(S\) URL/,
  );
  assert.throws(() => normalizeBaseUrl("file:///tmp/runner"), /must use http/);
  assert.throws(
    () => normalizeBaseUrl("https://user:pass@runner.example.com"),
    /must not include credentials/,
  );
  assert.throws(
    () => normalizeBaseUrl("https://runner.example.com/?debug=true"),
    /query string/,
  );
});
