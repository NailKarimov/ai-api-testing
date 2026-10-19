# ai-api-testing

[![Tests](https://github.com/NailKarimov/ai-api-testing/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/ai-api-testing/actions/workflows/tests.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/ai-api-testing/)

Testing the APIs that AI assistants use: an **MCP server** of our own, and next an **LLM endpoint**.

- **System under test:** `services/fx-mcp`, a Model Context Protocol server that converts money at a fixed
  reference table: four tools (one with progress and cancellation, one that changes the server), three resources, a
  prompt, argument completion. Served over **stdio** and **Streamable HTTP** (sessions, bearer tokens with scopes,
  OAuth Protected Resource Metadata, Origin checks).
- **One suite, two transports:** the same 42 tests run over stdio (the server as a child process) and over HTTP.
- **The wire as the oracle:** every JSON-RPC message is recorded; tests assert on it where the SDK would hide
  something, and the transcripts go to the Allure report with tokens masked.

## MCP (100 tests)

| Spec                        | What it proves                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp/handshake-and-tools`   | protocol version and capabilities; tool schemas and annotations; **tool metadata safe to show a model** (no hidden characters or injected instructions); exact conversions from an independent oracle; business errors as `isError` results a model can act on; progress before the result; cancellation really stops the work; `list_changed` |
| `mcp/resources-and-prompts` | resources, templates, completion; resources and tools agree; bad URIs (`..`, `file:///etc/passwd`) refused; prompts; the admin tool trusted over stdio, scope-checked over HTTP                                                                                                                                                                |
| `mcp-http/protocol`         | sessions (400 / 404 / DELETE), 401 with RFC 9728 metadata, `Origin` → 403, JSON-RPC errors, protocol-version header, `Accept` → 406, read-only token                                                                                                                                                                                           |
| `inspector/inspector-cli`   | MCP Inspector 2.x (SDK v2, spec 2026-07-28) against our SDK v1 server: a compatibility check                                                                                                                                                                                                                                                   |

**Findings.** The SDK 1.32 client can drop the last progress notification when it arrives together with the result
(the server is right; the test asserts on the wire). The Inspector CLI sends `amount=100` as a number, which the
schema rightly refuses. **Do the tests catch bugs?** 14 bugs planted: 13 caught, the 14th is an equivalent mutant
(the SDK turns a thrown error into the same tool result). The first run missed "cancellation ignored", which led to
an operational resource that makes abandoned work visible. Details: [`docs/mcp.md`](docs/mcp.md) · visual guide:
[`docs/mcp.html`](https://nailkarimov.github.io/ai-api-testing/mcp.html).

**Next:** an LLM endpoint: non-deterministic answers, evals with pass-rate thresholds, latency, prompt injection.

## Running it

```bash
npm ci
npm test                 # everything
npm run test:mcp         # MCP: stdio, HTTP, raw protocol, Inspector
npm run mcp:http         # by hand: http://127.0.0.1:3333/mcp, tokens dev-read and dev-admin
npx mcp-inspector --cli http://127.0.0.1:3333/mcp --header "Authorization: Bearer dev-read" --method tools/list
```

## Part of a portfolio

REST and GraphQL: [api-test-automation](https://github.com/NailKarimov/api-test-automation) · contracts:
[contract-testing-lab](https://github.com/NailKarimov/contract-testing-lab) · microservices:
[microservices-testing](https://github.com/NailKarimov/microservices-testing) · database and OAuth 2.0:
[ledger-api-testing](https://github.com/NailKarimov/ledger-api-testing) · gRPC, WebSocket, SSE:
[api-protocols-testing](https://github.com/NailKarimov/api-protocols-testing) · overview:
[github.com/NailKarimov](https://github.com/NailKarimov).

**Stack:** TypeScript · Model Context Protocol (`@modelcontextprotocol/sdk`, MCP Inspector) · JSON-RPC 2.0 · zod ·
Playwright Test · Allure · GitHub Actions.
