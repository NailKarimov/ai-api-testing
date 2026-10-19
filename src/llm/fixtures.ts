import { test as base, expect } from '../fixtures';
import { buildAssistantServer } from '../../services/fx-assistant/src/http.ts';
import { startFakeAnthropic } from './FakeAnthropic';
import { env } from '../../config/env';

/** A placeholder for the fake API; real keys never appear in the repository or the report. */
export const FAKE_KEY = 'sk-ant-test-only-fake-key';

type Ask = (
  question: unknown,
) => Promise<{ status: number; body: Record<string, unknown>; headers: Headers }>;

/** Plumbing tests: the service in-process, its model replaced by the fake Messages API. */
export const test = base.extend<{
  fake: Awaited<ReturnType<typeof startFakeAnthropic>>;
  ask: Ask;
  baseUrl: string;
}>({
  // eslint-disable-next-line no-empty-pattern
  fake: async ({}, use) => {
    const fake = await startFakeAnthropic();
    await use(fake);
    await fake.close();
  },
  baseUrl: async ({ fake }, use) => {
    const app = buildAssistantServer({
      apiKey: FAKE_KEY,
      baseURL: fake.url,
      timeoutMs: 1_000,
      maxRetries: 2,
    });
    await use(await app.listen());
    await app.close();
  },
  ask: async ({ baseUrl }, use, testInfo) => {
    const log: string[] = [];
    await use(async (question) => {
      const res = await fetch(`${baseUrl}/v1/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:
          typeof question === 'string' && question.startsWith('{raw}')
            ? question.slice(5)
            : JSON.stringify({ question }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      log.push(
        `POST /v1/answer ${JSON.stringify(question).slice(0, 300)}\n→ ${res.status} ${JSON.stringify(body).slice(0, 1500)}`,
      );
      return { status: res.status, body, headers: res.headers };
    });
    await testInfo.attach('fx-assistant calls', { contentType: 'text/plain', body: log.join('\n\n') });
  },
});

export { expect, env };
