// Summarises eval-results/*.json: pass rate per category, latency percentiles, tokens and estimated cost, and fails
// the job when a budget is exceeded. Writes markdown to $GITHUB_STEP_SUMMARY and eval-results/summary.md.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const PRICE = { inputPerMTok: 0.1, outputPerMTok: 0.5 }; // claude-haiku-5-5 base price, lower bound
const BUDGET = { maxCostUsd: 0.25, p95LatencyMs: 20_000 };

if (!existsSync('eval-results')) {
  console.log('No eval results (ANTHROPIC_API_KEY not set?).');
  process.exit(0);
}
const cases = readdirSync('eval-results')
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(`eval-results/${f}`, 'utf8')));
const attempts = cases.flatMap((c) => c.attempts.map((a) => ({ ...a, category: c.category })));
const lat = attempts.map((a) => a.latencyMs).sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] ?? 0;
const tokens = attempts.reduce(
  (t, a) => ({
    in: t.in + (a.result?.usage.input_tokens ?? 0),
    out: t.out + (a.result?.usage.output_tokens ?? 0),
  }),
  { in: 0, out: 0 },
);
const cost = (tokens.in / 1e6) * PRICE.inputPerMTok + (tokens.out / 1e6) * PRICE.outputPerMTok;
const categories = [...new Set(cases.map((c) => c.category))];

const lines = [
  '## fx-assistant evals (claude-haiku-5-5)',
  '',
  '| Category | Cases passing | Attempts passing |',
  '| --- | --- | --- |',
  ...categories.map((cat) => {
    const cs = cases.filter((c) => c.category === cat);
    const at = attempts.filter((a) => a.category === cat);
    return `| ${cat} | ${cs.filter((c) => c.passed >= c.minPass).length}/${cs.length} | ${at.filter((a) => a.pass).length}/${at.length} |`;
  }),
  '',
  '| Case | Passed | Required | Failures |',
  '| --- | --- | --- | --- |',
  ...cases.map((c) => {
    const why = c.attempts.filter((a) => !a.pass).map((a) => a.error ?? a.reasons.join('; '));
    return `| ${c.id} | ${c.passed}/${c.runs} | ${c.minPass} | ${why.join(' / ').replaceAll('|', '\\|') || '—'} |`;
  }),
  '',
  `Latency per answer: p50 ${pct(50)} ms, p95 ${pct(95)} ms (budget ${BUDGET.p95LatencyMs} ms).`,
  `Tokens: ${tokens.in} in, ${tokens.out} out. Estimated cost at base price: $${cost.toFixed(4)} (budget $${BUDGET.maxCostUsd}).`,
];
const md = lines.join('\n');
writeFileSync('eval-results/summary.md', md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
console.log(md);
if (cost > BUDGET.maxCostUsd || pct(95) > BUDGET.p95LatencyMs) {
  console.error('Budget exceeded.');
  process.exit(1);
}
