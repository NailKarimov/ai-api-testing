# ai-api-testing

[![Tests](https://github.com/NailKarimov/ai-api-testing/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/ai-api-testing/actions/workflows/tests.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/ai-api-testing/)

Testing the APIs that AI assistants use: an **MCP server** of our own and an **LLM endpoint** built on Claude.

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

## LLM endpoint (20 plumbing tests + 13 evals)

`services/fx-assistant`: `POST /v1/answer` takes a customer's question in any language; **Claude Haiku 5.5** answers
with structured JSON output, calling the `convert` tool for every number. The service then checks the model's work:
the answer must match the schema, and every amount must come from a tool call (**groundedness**), or it says so.

| Layer                       | What it proves                                                                                                                                                                                                                                                                                                                                                                                    | When it runs                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `llm/plumbing` (20)         | against a **fake Messages API** (the real SDK, a local stub): the exact request (pinned model, strict tool, JSON schema, system prompt), the tool loop with ids, tool errors fed back to the model, hallucinated amounts flagged, broken / truncated output → 502, refusal, endless tool calls stopped, 529 retried then 503 + Retry-After, timeout → 504, the key never echoed, input boundaries | every push, free                                                      |
| `evals` (13 cases × 3 runs) | against the **real model**: exact conversions in English and Russian, two at once, casual wording; asking for a missing currency; no invented rates (Bitcoin, 1999); refusing off-topic requests; **prompt injection** must never leak the system prompt (a canary string), 3 runs out of 3                                                                                                       | `evals.yml`: by hand and weekly, needs the `ANTHROPIC_API_KEY` secret |

A model answers differently each time, so each eval runs 3 times and needs a pass count (3/3 for safety, ≥ 2/3 for
some quality cases). `scripts/eval-summary.mjs` reports pass rates per category, latency p50/p95 and tokens with an
estimated cost, and fails the run over budget ($0.25 or p95 > 20 s). First real run: 11/13, the two "leaks" were
correct refusals misread by a keyword check; with an exact, tested oracle: **13/13**. 10 bugs planted in the plumbing: all caught.
Details: [`docs/llm.md`](docs/llm.md) · visual guide: [`docs/llm.html`](https://nailkarimov.github.io/ai-api-testing/llm.html).

## Running it

```bash
npm ci
npm test                 # everything
npm run test:mcp         # MCP: stdio, HTTP, raw protocol, Inspector
npm run test:llm         # LLM endpoint against the fake Messages API
npm run evals            # real Claude: needs ANTHROPIC_API_KEY in .env (see .env.example)
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

**Stack:** TypeScript · Model Context Protocol (`@modelcontextprotocol/sdk`, MCP Inspector) · JSON-RPC 2.0 · Claude API
(`@anthropic-ai/sdk`, structured outputs, tool use) · zod ·
Playwright Test · Allure · GitHub Actions.
