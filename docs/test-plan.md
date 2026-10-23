# Test plan: MCP server and LLM endpoint (ai-api-testing)

The structure follows ISO/IEC/IEEE 29119-3 (test plan), shortened for one project.

## 1. Context

- **Systems under test:**
  - `fx-mcp`, a Model Context Protocol server of our own, served over stdio and Streamable HTTP;
  - `fx-assistant`, an endpoint that answers money questions with Claude, using tool calls for every number.
- **Goal:** show that what a model sees is correct and safe, that it can only do what it is allowed to, and that
  answers built on a model are grounded and resist prompt injection.
- **References:**
  - Model Context Protocol specification;
  - JSON-RPC 2.0;
  - OAuth 2.0 Protected Resource Metadata (RFC 9728);
  - OWASP Top 10 for LLM Applications (LLM01 prompt injection, LLM02 sensitive information disclosure).

## 2. Scope

| In scope                                                          | Out of scope                                      |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| MCP tools, resources, prompts, completion, progress, cancellation | other MCP servers                                 |
| HTTP transport: sessions, tokens, scopes, Origin, headers         | an OAuth authorization server (tokens are static) |
| the LLM endpoint's request, tool loop, errors, output checks      | the model's general quality                       |
| evals: correctness, groundedness, refusals, prompt injection      | fine-tuning, model choice                         |

## 3. Quality characteristics (ISO/IEC 25010)

| Characteristic         | Covered by                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Functional correctness | exact conversions against an independent oracle; evals                                                       |
| Compatibility          | the same suite over both transports; MCP Inspector as an independent client                                  |
| Security               | scopes, Origin checks, path traversal, safe tool metadata, the prompt-injection canary, the key never echoed |
| Reliability            | 529 retried, timeouts, endless tool loops stopped                                                            |

## 4. Approach

- **MCP:** one suite runs over two transports. Every JSON-RPC message is recorded and asserted where the SDK would
  hide something.
- **LLM plumbing:** the real SDK talks to a local fake Messages API, so every push tests the request and the error
  handling for free.
- **Evals:** 13 cases, each run 3 times against the real model, with pass counts (3/3 for safety, ≥ 2/3 for some
  quality cases), a cost budget and a latency budget.
- **Test quality:** bugs planted by hand, 14 in MCP and 10 in the plumbing.

## 5. Risks

| Risk                                          | Mitigation                                                        |
| --------------------------------------------- | ----------------------------------------------------------------- |
| Model answers vary                            | 3 runs per case and pass counts instead of one run                |
| A keyword oracle misreads a refusal as a leak | a canary string and an exact, tested leak check                   |
| Evals cost money                              | a weekly schedule, a $0.25 budget, the cheapest suitable model    |
| The API key leaks into logs or reports        | the key comes only from secrets; a test checks it is never echoed |

## 6. Entry and exit criteria

- **Entry:** lint, format and typecheck pass. The evals also need the API key secret.
- **Exit:** all tests pass; evals at or above their pass counts within budget; every planted bug caught or shown
  to be equivalent.

## 7. Deliverables

The test suite, the Allure report on GitHub Pages, the eval summary in the workflow, [`test-report.md`](test-report.md)
and the two guides.
