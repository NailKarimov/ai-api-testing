# MCP: testing a Model Context Protocol server

Visual version (what MCP is, the session as a conversation you step through, a tool error vs a protocol error,
the HTTP security checks, tool poisoning, RU/EN):
[`docs/mcp.html`](https://nailkarimov.github.io/ai-api-testing/mcp.html).

## What MCP is

The **Model Context Protocol** is how an AI assistant (Claude, ChatGPT, an IDE agent) connects to outside tools and
data. An MCP **server** offers three things:

| Primitive     | Who decides to use it | Example in fx-mcp                                      |
| ------------- | --------------------- | ------------------------------------------------------ |
| **Tools**     | the model             | `convert`: 100 EUR → JPY                               |
| **Resources** | the application       | `fx://currencies`, `fx://rates/{base}`: data to read   |
| **Prompts**   | the user              | `explain_conversion`: a ready-made instruction to pick |

Messages are JSON-RPC 2.0. A session starts with `initialize` (versions and capabilities are agreed), then the
client lists and calls things; the server can send notifications (progress, "my list changed"). Two transports:
**stdio** (the assistant starts the server as a child process: a local trust boundary) and **Streamable HTTP**
(a remote server with sessions and OAuth tokens).

For a tester the new part is that the consumer is a **model**. Tool descriptions are read by it, so they are an
attack surface (tool poisoning), and errors have to be written so a model can correct itself.

## The system under test: fx-mcp

`services/fx-mcp` converts money at a fixed reference table, so every expected answer is known exactly.
Built on `@modelcontextprotocol/sdk` 1.32 (MCP spec 2025-11-25).

| Name                 | Kind                | Notes                                                                                        |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `convert`            | tool, read-only     | `outputSchema` + `structuredContent`; ISO 4217 minor units (JPY has none); half-up rounding  |
| `list_rates`         | tool, read-only     | every rate against a base                                                                    |
| `slow_report`        | tool, read-only     | sends `notifications/progress` per step; stops when the client cancels                       |
| `enable_currency`    | tool, changes state | switches on NOK and sends `notifications/resources/list_changed`; over HTTP needs `fx:admin` |
| `fx://currencies`    | resource            | codes and minor units                                                                        |
| `fx://rates/{base}`  | resource template   | with argument completion                                                                     |
| `fx://server/jobs`   | resource            | running / finished / cancelled reports (operational view)                                    |
| `explain_conversion` | prompt              | three arguments, completion for the currencies                                               |

**Errors.** A business problem (an unknown currency, too many decimals for JPY, arguments that break the input
schema) is a **tool result with `isError: true`** and a sentence the model can act on: "Unknown currency: XYZ.
Known: CHF, EUR, …". A broken request (malformed JSON, an unknown method, a missing prompt argument) is a
**JSON-RPC error** (`-32700`, `-32601`, `-32602`).

**Streamable HTTP** (`buildHttpServer`): `Mcp-Session-Id` after `initialize`; no session → 400, unknown session →
404, `DELETE` ends it; `Authorization: Bearer` with scopes, and without a token a 401 whose `WWW-Authenticate`
points to the **OAuth Protected Resource Metadata** (RFC 9728) at `/.well-known/oauth-protected-resource`, as the
MCP authorization spec requires; `Origin` checked against an allow-list against DNS rebinding.

## How it is tested

- **One suite, two transports.** Playwright projects `mcp-stdio` and `mcp-http` run the same 42 tests: stdio spawns
  the server as a child process like a desktop assistant does; HTTP starts a fresh in-process server per test.
- **The wire as the oracle.** `src/mcp/LoggingTransport.ts` records every JSON-RPC message both ways; tests assert on
  it where the SDK client would hide something, and every transcript is attached to the report (tokens masked).
- **Raw protocol tests** (`mcp-http-protocol`, 12): plain `fetch`, no SDK, so the tests see what any client or
  attacker sees.
- **An independent client** (`inspector`, 4): MCP Inspector 2.x, built on SDK v2 and spec 2026-07-28, drives the
  server over stdio and HTTP. A compatibility check across SDK generations.
- **Expected values from an independent oracle**: the conversion table was computed with Python `Decimal`
  (`ROUND_HALF_UP`), not with the code under test.

## What the tests check (100)

| Spec                                 | Technique                       | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp/handshake-and-tools` (27 × 2)   | Contract, boundary, negative    | server identity, capabilities, instructions, protocol 2025-11-25; tools/list and schemas; annotations; **tool metadata lint against poisoning** (hidden characters, injected instructions); 8 exact conversions incl. JPY, rounding, zero and the largest amount; output schema; unknown currency and JPY decimals as tool errors; 6 schema violations as tool errors naming the field; unknown tool; progress in order **before** the result; cancellation stops the server (`fx://server/jobs`); client timeout −32001; `list_changed` after `enable_currency` |
| `mcp/resources-and-prompts` (15 × 2) | Contract, negative, consistency | resources and templates listed; JSON with minor units; `fx://rates/USD` agrees with the `convert` tool; 5 bad URIs (unknown, lower case, `..`, other scheme, `file:///etc/passwd`) refused without stack traces; completion; prompt arguments, text, −32602 for a missing argument; **trust boundary**: the admin tool works over stdio, needs `fx:admin` over HTTP                                                                                                                                                                                              |
| `mcp-http/protocol` (12)             | Security, protocol              | session id; 401 + RFC 9728 metadata; wrong token → no session; foreign `Origin` → 403; 400 / 404 / `DELETE`; independent sessions; −32700, −32601; unsupported `MCP-Protocol-Version` → 400; `Accept` without SSE → 406; a read-only token cannot change the server                                                                                                                                                                                                                                                                                              |
| `inspector/inspector-cli` (4)        | Interoperability                | tools/list and convert through the Inspector over stdio, resources/read over HTTP with a token; a CLI type pitfall (below)                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Findings

- **MCP-1: the SDK client can lose the last progress notification.** The server sends every
  `notifications/progress` before the result, as it must. When the last one and the result arrive in the same chunk
  of stdout, the SDK 1.32 client sometimes drops it before calling `onprogress` (about half the runs under parallel
  load, reproduced outside Playwright). The test now asserts on the recorded wire, which is the server's real
  contract; a UI built on `onprogress` would show 80 % on a finished report.
- **MCP-2: the Inspector CLI turns `--tool-arg amount=100` into a number.** The schema rightly refuses it
  (`expected string, received number at amount`); `amount="100"` works. Amounts as strings are a deliberate choice
  (no binary floats for money), so clients must not coerce them.
- **A gap the first planted-bug run exposed.** "The server ignores cancellation" was not caught: the SDK suppresses
  notifications of a cancelled request, so the abandoned work was invisible. The `fx://server/jobs` resource makes it
  visible, and the cancellation test now checks that nothing keeps running.

## Do the tests catch real bugs?

| Planted bug                                                    | Caught by                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| truncation instead of half-up rounding                         | 5 conversions × 2 transports                                                                     |
| decimals not checked against the currency                      | `more decimals than the currency has` (2)                                                        |
| no structured content                                          | 22 tests                                                                                         |
| progress without `total`                                       | `progress: one notification per step …` (2)                                                      |
| cancellation ignored                                           | `cancellation: … the server stops working` (2), after the fix                                    |
| no `list_changed` after `enable_currency`                      | `enable_currency changes the server and announces it` (2)                                        |
| no `Origin` check                                              | `DNS rebinding: a foreign Origin → 403`                                                          |
| no token check                                                 | `no token → 401 …`, `a wrong token → 401` (2)                                                    |
| no scope check for the admin tool                              | trust boundary + protocol (2)                                                                    |
| a poisoned tool description (`<IMPORTANT>Ignore previous …`)   | `tool metadata is safe to show a model` (2)                                                      |
| the rates resource accepts lower-case codes                    | `reading fx://rates/usd → an error` (2)                                                          |
| completion ignores the prefix                                  | `completion: "U" for {base} suggests USD` (2)                                                    |
| an unknown session answered 400 instead of 404                 | session tests (2)                                                                                |
| an unknown currency thrown instead of returned as a tool error | not caught: an **equivalent mutant**, the SDK turns the exception into the same `isError` result |

13 of 14 caught; the 14th behaves identically for every client, so no test can or should tell it apart.

## Running

```bash
npm run test:mcp                          # both transports
npx playwright test --project=mcp-http-protocol
npm run mcp:stdio                         # the server on stdio
npm run mcp:http                          # http://127.0.0.1:3333/mcp, tokens dev-read and dev-admin
npx mcp-inspector --cli http://127.0.0.1:3333/mcp --header "Authorization: Bearer dev-read" --method tools/list
npx mcp-inspector                         # the Inspector web UI
```
