# ai-api-testing

[![Tests](https://github.com/NailKarimov/ai-api-testing/actions/workflows/tests.yml/badge.svg)](https://github.com/NailKarimov/ai-api-testing/actions/workflows/tests.yml)
[![Evals](https://github.com/NailKarimov/ai-api-testing/actions/workflows/evals.yml/badge.svg)](https://github.com/NailKarimov/ai-api-testing/actions/workflows/evals.yml)
[![Allure report](https://img.shields.io/badge/report-Allure-orange)](https://nailkarimov.github.io/ai-api-testing/)
[![Release](https://img.shields.io/github/v/release/NailKarimov/ai-api-testing)](https://github.com/NailKarimov/ai-api-testing/releases)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/NailKarimov/ai-api-testing?quickstart=1)

### ▶ Open online

| Page                                                                    | What it is        |
| ----------------------------------------------------------------------- | ----------------- |
| **[Allure test report](https://nailkarimov.github.io/ai-api-testing/)** | latest CI run     |
| [MCP server](https://nailkarimov.github.io/ai-api-testing/mcp.html)     | interactive guide |
| [LLM endpoint](https://nailkarimov.github.io/ai-api-testing/llm.html)   | interactive guide |

Click these links: opening an `.html` file in the file list shows its source code, GitHub does not run it.

Testing the APIs that AI assistants use: an **MCP server** of our own and an **LLM endpoint** built on Claude. The
tests check what the model sees, what it is allowed to do, and whether its answers can be trusted.

|                        |                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System under test**  | own MCP server `fx-mcp` (tools, resources, prompts; stdio and Streamable HTTP with scopes) and own LLM endpoint `fx-assistant` (Claude Haiku 5.5 with tool use and structured output)             |
| **Language and tools** | TypeScript · Playwright Test · `@modelcontextprotocol/sdk` · MCP Inspector · `@anthropic-ai/sdk` · zod · Allure                                                                                   |
| **Types of testing**   | functional API (JSON-RPC), protocol conformance, security (scopes, Origin, path traversal, tool poisoning, prompt injection), LLM evals (correctness, groundedness)                               |
| **Tests**              | 126 on every push (100 MCP, 20 LLM plumbing, 6 unit) + 13 evals × 3 runs against the real model                                                                                                   |
| **Test quality**       | 23 of 24 planted bugs caught; the 24th is an equivalent mutant (13 of 14 in MCP, 10 of 10 in the LLM plumbing)                                                                                    |
| **Reports**            | [Allure](https://nailkarimov.github.io/ai-api-testing/) · [MCP guide](https://nailkarimov.github.io/ai-api-testing/mcp.html) · [LLM guide](https://nailkarimov.github.io/ai-api-testing/llm.html) |

## What is tested

| Suite                       | Tool                    | What it proves                                                                                                                                                                                                                  |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp/handshake-and-tools`   | MCP SDK, stdio and HTTP | protocol version and capabilities; tool schemas and annotations; tool metadata safe to show a model; exact conversions from an independent oracle; business errors as `isError` results; progress, cancellation, `list_changed` |
| `mcp/resources-and-prompts` | MCP SDK                 | resources, templates, completion; bad URIs (`..`, `file:///etc/passwd`) refused; prompts; the admin tool trusted over stdio, scope-checked over HTTP                                                                            |
| `mcp-http/protocol`         | raw HTTP                | sessions; 401 with RFC 9728 metadata; `Origin` → 403; JSON-RPC errors; the protocol-version header; `Accept` → 406; a read-only token                                                                                           |
| `inspector/inspector-cli`   | MCP Inspector 2.x       | an independent client against our server: a compatibility check                                                                                                                                                                 |
| `llm/plumbing` (20)         | a fake Messages API     | the exact request (pinned model, strict tool, JSON schema); the tool loop; tool errors fed back; hallucinated amounts flagged; broken output → 502; 529 retried, then 503; timeout → 504; the key never echoed                  |
| `evals` (13 × 3)            | the real Claude API     | exact conversions in English and Russian; asking for a missing currency; no invented rates; refusing off-topic requests; **prompt injection never leaks the system prompt** (a canary)                                          |

## Findings

- **MCP SDK 1.32 can drop the last progress notification** when it arrives together with the result. The server
  is right, and the test asserts on the recorded wire, not on the SDK's callbacks.
- **The Inspector CLI sends `amount=100` as a number,** which the schema rightly refuses.
- **The first eval run scored 11/13.** The two "leaks" were correct refusals misread by a keyword check. With an
  exact, tested oracle the score is **13/13**.
- **"Cancellation ignored" survived the first mutation round.** That led to an operational resource that makes
  abandoned work visible.

## Running it

No local setup: the **Open in GitHub Codespaces** badge starts a browser VS Code with this repository, its tools and Docker; the container runs `npm ci` on creation, then `npm test` works in the terminal.

Requirements: Node.js 22+, Java 17+ for a local Allure report. The evals also need `ANTHROPIC_API_KEY` in `.env`.

```bash
npm ci
npm test                 # everything except the evals
npm run test:mcp         # MCP: stdio, HTTP, raw protocol, Inspector
npm run test:llm         # LLM endpoint against the fake Messages API
npm run evals            # real Claude; budget $0.25, p95 20 s
npm run mcp:http         # by hand: http://127.0.0.1:3333/mcp, tokens dev-read and dev-admin
npx mcp-inspector --cli http://127.0.0.1:3333/mcp --header "Authorization: Bearer dev-read" --method tools/list
```

## Project structure

```text
services/fx-mcp/        the MCP server: tools, resources, prompts, stdio and HTTP transports
services/fx-assistant/  the LLM endpoint: tool loop, structured output, groundedness check
src/mcp/, src/llm/      clients, wire recorder, the fake Messages API, oracles
src/fixtures.ts         server per worker, both transports
tests/mcp/, tests/mcp-http/, tests/inspector/   MCP specs
tests/llm/              plumbing specs
tests/evals/            evals against the real model
tests/unit/             the leak check used by the evals
scripts/                Allure preparation, eval summary with cost and latency
docs/                   test plan, test report, guides
```

## CI

- `tests.yml` runs on push, pull request, nightly at 03:00 UTC and on demand: lint, format, typecheck, all tests
  except the evals, and the Allure report with history on GitHub Pages.
- `evals.yml` runs by hand and every Monday at 04:00 UTC. It needs the `ANTHROPIC_API_KEY` secret and fails over
  budget ($0.25, or p95 > 20 s).

Releases: committing `.github/releases/<tag>.md` runs the Release workflow, which creates the tag and the GitHub release with that file as its notes.

## Documentation

| Document                                                                                       | What it is                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`docs/test-plan.md`](docs/test-plan.md)                                                       | test plan (ISO/IEC/IEEE 29119-3)                                                                           |
| [`docs/test-report.md`](docs/test-report.md)                                                   | test summary report: latest results, findings, recommendations                                             |
| [`docs/mcp.md`](docs/mcp.md) · [visual](https://nailkarimov.github.io/ai-api-testing/mcp.html) | MCP: tools, resources, prompts, `isError` vs JSON-RPC errors, tool poisoning, HTTP security, the Inspector |
| [`docs/llm.md`](docs/llm.md) · [visual](https://nailkarimov.github.io/ai-api-testing/llm.html) | the LLM endpoint: plumbing on a fake API, evals, groundedness, the prompt-injection canary                 |

## Part of a portfolio

One of 13 test automation projects by [Nail Karimov](https://github.com/NailKarimov):
[all projects](https://github.com/NailKarimov) ·
[testing map](https://nailkarimov.github.io/api-test-automation/testing-map.html) ·
[toolbox](https://nailkarimov.github.io/api-test-automation/toolbox.html).
