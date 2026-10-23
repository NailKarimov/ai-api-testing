# Test summary report: MCP server and LLM endpoint (ai-api-testing)

The structure follows ISO/IEC/IEEE 29119-3 (test completion report), shortened.

- **Period:** 19.10.2026 – 23.10.2026
- **Build:** `main`, latest nightly run in GitHub Actions
- **Allure report:** https://nailkarimov.github.io/ai-api-testing/

## 1. Summary

All 126 tests that run on every push pass. The latest eval run scored 13/13: conversions were exact, every
amount came from a tool call, and the system prompt never leaked under injection.

## 2. Results

| Metric              | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Tests on every push | 126 passed: 100 MCP, 20 LLM plumbing, 6 unit; the 13 evals are skipped without a key |
| Evals (real model)  | 13 of 13 cases at their pass counts, 3 runs each, within budget                      |
| Duration            | ~18 s without the evals                                                              |
| Mutation check      | MCP 13 of 14 (the 14th is equivalent); plumbing 10 of 10                             |

## 3. Findings

| ID   | Severity              | Summary                                                                              | Status                                          |
| ---- | --------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| AI-1 | minor (third-party)   | MCP SDK 1.32 can drop the last progress notification when it arrives with the result | worked around: the test asserts on the wire     |
| AI-2 | trivial (third-party) | the Inspector CLI sends `amount=100` as a number                                     | documented; the server's refusal is correct     |
| AI-3 | major (test oracle)   | a keyword check counted correct refusals as leaks (11/13)                            | fixed: a canary and an exact leak check (13/13) |

## 4. Deviations from the plan

- Evals do not run on every push, because of their cost. They run by hand and weekly.

## 5. Recommendations

1. Add more languages and wordings to the evals before changing the model or the prompt.
2. Keep the wire recorder. SDK callbacks can hide protocol messages.
