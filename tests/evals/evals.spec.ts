import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildAssistant, type AssistantResult } from '../../services/fx-assistant/src/assistant.ts';
import { CASES } from '../../evals/cases';

/**
 * Evals against the real Claude API. Skipped without ANTHROPIC_API_KEY (a repository secret in CI, never in the
 * code). Each attempt is written to eval-results/ for scripts/eval-summary.mjs: pass rates, latency, tokens, cost.
 */
const key = (process.env.ANTHROPIC_API_KEY ?? '').trim();
test.skip(!key, 'ANTHROPIC_API_KEY is not set: evals run only in evals.yml');

for (const c of CASES) {
  test(`${c.category}: ${c.id} (≥ ${c.minPass}/${c.runs})`, async () => {
    const assistant = buildAssistant({ apiKey: key, timeoutMs: 60_000, maxRetries: 3 });
    const attempts: {
      pass: boolean;
      reasons: string[];
      latencyMs: number;
      result?: AssistantResult;
      error?: string;
    }[] = [];
    for (let i = 0; i < c.runs; i++) {
      const started = Date.now();
      try {
        const result = await assistant.ask(c.question);
        const reasons = c.checks.map((check) => check(result)).filter((x): x is string => !!x);
        attempts.push({ pass: reasons.length === 0, reasons, latencyMs: Date.now() - started, result });
      } catch (e) {
        attempts.push({
          pass: false,
          reasons: ['error'],
          latencyMs: Date.now() - started,
          error: (e as Error).message,
        });
      }
    }
    const passed = attempts.filter((a) => a.pass).length;
    mkdirSync('eval-results', { recursive: true });
    writeFileSync(
      `eval-results/${c.id}.json`,
      JSON.stringify(
        {
          id: c.id,
          category: c.category,
          question: c.question,
          runs: c.runs,
          minPass: c.minPass,
          passed,
          attempts,
        },
        null,
        2,
      ),
    );
    await test.info().attach(`${c.id}: ${passed}/${c.runs}`, {
      contentType: 'application/json',
      body: JSON.stringify({ question: c.question, attempts }, null, 2).replaceAll(key, '***'),
    });

    expect(
      passed,
      attempts
        .map((a, i) => `#${i + 1}: ${a.pass ? 'pass' : a.reasons.join('; ')} ${a.error ?? ''}`)
        .join('\n'),
    ).toBeGreaterThanOrEqual(c.minPass);
  });
}
