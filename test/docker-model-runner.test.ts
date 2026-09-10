import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_BASE_URL,
  discoverModels,
  modelsUrl,
  normalizeBaseUrl,
} from "../src/docker-model-runner.ts";
import { isDockerModelRunnerBaseUrl, readDockerModelRunnerProviders } from "../src/models-json.ts";

test("uses Docker Model Runner's documented OpenAI endpoint by default", () => {
  assert.equal(normalizeBaseUrl(""), DEFAULT_BASE_URL);
  assert.equal(modelsUrl("http://localhost:12434"), "http://localhost:12434/engines/v1/models");
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
});

test("discovers and normalizes OpenAI model IDs", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ data: [{ id: "ai/qwen", dmr: { context_window: 32768 } }, { id: "ai/qwen" }, {}, { id: 4 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const models = await discoverModels("http://localhost:12434", "proxy-token", new AbortController().signal);
    assert.deepEqual(models.map((model) => model.id), ["ai/qwen"]);
    assert.equal(models[0]?.baseUrl, DEFAULT_BASE_URL);
    assert.equal(models[0]?.contextWindow, 32768);
    assert.equal(request?.url, `${DEFAULT_BASE_URL}/models`);
    assert.equal(request?.headers.get("authorization"), "Bearer proxy-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finds arbitrary Docker Model Runner provider IDs in models.json", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-dmr-")), "models.json");
  writeFileSync(path, JSON.stringify({
    providers: {
      "dmr-lab": { name: "Lab runner", baseUrl: "https://lab.example.com/engines/v1" },
      "dmr-llama": { baseUrl: "http://localhost:12434/engines/llama.cpp/v1" },
      unrelated: { baseUrl: "http://localhost:11434/v1" },
    },
  }));

  assert.equal(isDockerModelRunnerBaseUrl("http://localhost:12434/engines/v1"), true);
  assert.equal(isDockerModelRunnerBaseUrl("http://localhost:11434/v1"), false);
  assert.deepEqual(readDockerModelRunnerProviders(path), [
    { id: "dmr-lab", name: "Lab runner", baseUrl: "https://lab.example.com/engines/v1" },
    { id: "dmr-llama", name: undefined, baseUrl: "http://localhost:12434/engines/llama.cpp/v1" },
  ]);
});

test("rejects unsafe or malformed endpoint URLs", () => {
  assert.throws(() => normalizeBaseUrl("runner.example.com"), /valid HTTP\(S\) URL/);
  assert.throws(() => normalizeBaseUrl("file:///tmp/runner"), /must use http/);
  assert.throws(() => normalizeBaseUrl("https://user:pass@runner.example.com"), /must not include credentials/);
  assert.throws(() => normalizeBaseUrl("https://runner.example.com/?debug=true"), /query string/);
});
