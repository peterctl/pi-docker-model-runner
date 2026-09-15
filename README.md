# pi Docker Model Runner

A [pi](https://github.com/badlogic/pi-mono) package that exposes [Docker Model Runner (DMR)](https://docs.docker.com/ai/model-runner/) as the dynamic `docker-model-runner` model provider.

It uses Docker Model Runner's OpenAI-compatible API, discovers the models currently available from the runner, and refreshes that catalog when pi refreshes its model list.

## Install

```bash
pi install git:github.com/peterctl/pi-docker-model-runner
```

Restart pi (or run `/reload` if the package was installed into an active installation), then configure the provider:

```text
/login docker-model-runner
```

## Login flow

`/login docker-model-runner` offers two choices:

- **Local Docker Model Runner** — defaults to `http://localhost:12434/engines/v1`.
- **Custom endpoint** — for a remote runner, reverse proxy, or non-default port.

The flow asks for an optional bearer token, validates the OpenAI-compatible `/models` endpoint, and reports the number of discovered models. The endpoint is saved as provider-scoped configuration in pi's normal credential storage. A token is stored by pi as a secret and is never written to this package's configuration.

Docker Model Runner itself does **not** authenticate its API and ignores the `Authorization` header. An optional token is provided solely for deployments placed behind an authenticating reverse proxy. For a tokenless connection, the OpenAI client requires the package to send a harmless placeholder bearer value; Docker Model Runner ignores it.

## Requirements

- pi `0.84.4` or newer.
- Docker Model Runner enabled and at least one model available. See Docker's [getting started guide](https://docs.docker.com/ai/model-runner/get-started/).
- Host TCP access enabled for the default Docker Desktop endpoint, for example:

  ```bash
  docker desktop enable model-runner --tcp 12434
  ```

Docker documents these OpenAI-compatible endpoints:

| Use | Base URL |
| --- | --- |
| Host process (Docker Desktop or Docker Engine) | `http://localhost:12434/engines/v1` |
| Container on Docker Desktop | `http://model-runner.docker.internal/engines/v1` |
| Explicit llama.cpp engine | `http://localhost:12434/engines/llama.cpp/v1` |

A custom endpoint must be an HTTP(S) OpenAI base URL. A bare host URL is normalized to `/engines/v1`; an engine-qualified path is retained.

> **Security:** Docker Model Runner's API is unauthenticated. Do not expose it directly to an untrusted network. Put remote access behind TLS and suitable network/authentication controls.

## Multiple connections and `models.json`

Pi's `~/.pi/agent/models.json` is the recommended source of truth for multiple Docker Model Runner connections. Provider keys are free-form, so each key becomes a separate provider in `/model`. This package recognizes entries whose `baseUrl` is a Docker Model Runner OpenAI endpoint (`/engines/v1` or `/engines/<engine>/v1`) and attaches dynamic discovery to each one.

```json
{
  "providers": {
    "dmr-lab": {
      "name": "Docker Model Runner (lab)",
      "baseUrl": "http://lab.example.internal:12434/engines/v1",
      "apiKey": "not-needed",
      "api": "openai-completions",
      "models": [
        {
          "id": "my-model",
          "name": "My model",
          "reasoning": true,
          "contextWindow": 262144,
          "maxTokens": 32768,
          "compat": { "thinkingFormat": "qwen-chat-template" }
        }
      ]
    },
    "dmr-desktop": {
      "name": "Docker Model Runner (desktop)",
      "baseUrl": "http://localhost:12434/engines/v1",
      "apiKey": "not-needed",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

`models.json` has the final say over names, context sizes, reasoning/tool compatibility, and other per-model metadata. It is layered above the discovered catalog, so Docker-reported settings are used first, conservative defaults fill any gaps, and explicit `models.json` values still win on conflicts. A model explicitly listed in `models.json` remains available even if discovery no longer returns it; `/docker-model-runner status` and `/docker-model-runner refresh` warn when a static entry is now stale. Existing configured connections and model overrides are re-read when `/model` refreshes. Add a **new provider key** and run `/reload` once so the extension can attach its discovery handler.

## Model discovery and refresh

The package calls Docker Model Runner's documented read endpoints and merges what they expose:

- `GET <openai-base-url>/models`
- `GET <openai-base-url>/models/{namespace}/{name}`
- `GET <runner-root>/models/{namespace}/{name}`
- `POST <runner-root>/api/show`

pi invokes the provider's `refreshModels()` whenever its model registry is refreshed, including when opening/refreshing `/model`. The package deliberately does not poll in the background.

You can force a refresh or inspect status manually:

```text
/docker-model-runner refresh
/docker-model-runner status
```

Docker's responses do not expose a complete Pi model definition, and some documented fields such as `dmr.context_window` can describe a model's maximum rather than the runner's effective configured runtime cap. This package therefore uses Docker Model Runner directly for every explicit field it can map, then falls back conservatively for anything Docker does not report clearly:

- text input only unless Docker explicitly reports image input too;
- no reasoning controls unless Docker explicitly reports them;
- 2,048 token context window when Docker does not expose one;
- 1,024 maximum output tokens when Docker does not expose one;
- local/zero token cost.

If you need a different name, context size, max output, or compatibility flag than Docker reports or omits, set it in `models.json`; those explicit values override discovery.

## Troubleshooting

- **Connection refused:** enable Model Runner and Docker Desktop TCP host access; verify `curl http://localhost:12434/engines/v1/models`.
- **No models found:** pull or create a model first, then run `/docker-model-runner refresh`.
- **HTTP 401/403 from a custom endpoint:** provide the reverse proxy's bearer token during `/login docker-model-runner`.
- **Model accepts prompts but tool calls fail:** Docker documents function calling as supported by llama.cpp for compatible models only. Try another model or disable tool usage for that session.

## Development

```bash
npm install
npm test
pi -e ./src/index.ts
```

The package has no build step: pi loads TypeScript extensions directly.

## License

[MIT](LICENSE)
