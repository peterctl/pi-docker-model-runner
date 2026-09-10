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

## Model discovery and refresh

The package calls `GET <base-url>/models`, Docker Model Runner's OpenAI-compatible model-list endpoint. It deliberately does not poll in the background. pi invokes the provider's `refreshModels()` whenever its model registry is refreshed, including when opening/refreshing `/model`.

You can force a refresh or inspect status manually:

```text
/docker-model-runner refresh
/docker-model-runner status
```

Docker's model-list response exposes model IDs but not the full capability metadata needed by pi. Version 1 therefore registers conservative metadata for each discovered model:

- text input only;
- no reasoning controls;
- 2,048 token context window;
- 1,024 maximum output tokens;
- local/zero token cost.

These defaults avoid advertising features that a selected Docker model may not support. Future versions can add verified per-model capability detection or user overrides.

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
