import { test, expect, FAKE_KEY } from '../../src/llm/fixtures';
import { answer, message, overloaded, text, toolUse } from '../../src/llm/FakeAnthropic';
import { CANARY, MODEL } from '../../services/fx-assistant/src/assistant.ts';

/**
 * The service around the model, tested against a fake Messages API: what it sends, how it runs the tool loop, and
 * what it does when the model or the API misbehaves. Deterministic, free, no key.
 */
test.describe('fx-assistant plumbing (fake model)', () => {
  test(
    'the request: pinned model, system prompt with the canary, strict tool, JSON schema output',
    { tag: '@smoke' },
    async ({ ask, fake }) => {
      fake.reply({ body: message([text(answer({ answer: 'Hello' }))]) });
      await ask('Hi');
      const req = fake.requests[0]!;
      const tools = req.body.tools as {
        name: string;
        strict: boolean;
        input_schema: { required: string[] };
      }[];

      expect(req.body.model).toBe(MODEL);
      expect(req.body.max_tokens).toBe(1024);
      expect(req.body.system).toContain(CANARY);
      expect(tools.map((t) => [t.name, t.strict, t.input_schema.required])).toEqual([
        ['convert', true, ['amount', 'from', 'to']],
      ]);
      expect(req.body.output_config).toMatchObject({
        format: {
          type: 'json_schema',
          schema: { required: ['answer', 'conversions', 'refused', 'needs_clarification'] },
        },
      });
      expect(req.headers['x-api-key']).toBe(FAKE_KEY);
      expect(req.headers['anthropic-version']).toBeTruthy();
    },
  );

  test('the tool loop: tool_use → our convert → tool_result → final answer, grounded', async ({
    ask,
    fake,
  }) => {
    fake.reply(
      {
        body: message(
          [text('Let me check.'), toolUse('tu_1', { amount: '100', from: 'EUR', to: 'JPY' })],
          'tool_use',
        ),
      },
      {
        body: message([
          text(
            answer({
              answer: '100 EUR is 16405 JPY.',
              conversions: [{ amount: '100', from: 'EUR', to: 'JPY', result: '16405' }],
            }),
          ),
        ]),
      },
    );
    const res = await ask('How much is 100 EUR in yen?');
    const second = fake.requests[1]!.body.messages as { role: string; content: unknown }[];

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      grounded: true,
      turns: 2,
      usage: { input_tokens: 240, output_tokens: 80 },
    });
    expect(res.body.tool_calls).toEqual([
      { input: { amount: '100', from: 'EUR', to: 'JPY' }, output: '100 EUR = 16405 JPY', isError: false },
    ]);
    // the assistant turn is sent back unchanged, then the tool result with the same id
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: '100 EUR = 16405 JPY', is_error: false },
    ]);
  });

  test('an unknown currency comes back to the model as a tool error, so it can correct itself', async ({
    ask,
    fake,
  }) => {
    fake.reply(
      { body: message([toolUse('tu_1', { amount: '5', from: 'EUR', to: 'XYZ' })], 'tool_use') },
      { body: message([text(answer({ answer: 'XYZ is not supported.' }))]) },
    );
    await ask('5 EUR to XYZ');
    const result = (
      fake.requests[1]!.body.messages as { content: { is_error?: boolean; content?: string }[] }[]
    )[2]!.content[0]!;

    expect(result.is_error).toBe(true);
    expect(result.content).toBe('Unknown currency: XYZ. Known: CHF, EUR, GBP, JPY, SEK, USD.');
  });

  test('hallucination guard: a result the tools never produced → grounded: false', async ({ ask, fake }) => {
    fake.reply(
      { body: message([toolUse('tu_1', { amount: '100', from: 'EUR', to: 'JPY' })], 'tool_use') },
      {
        body: message([
          text(
            answer({
              answer: '100 EUR is 16500 JPY.',
              conversions: [{ amount: '100', from: 'EUR', to: 'JPY', result: '16500' }],
            }),
          ),
        ]),
      },
    );
    expect((await ask('100 EUR in JPY?')).body.grounded).toBe(false);
  });

  test('hallucination guard: a conversion with no tool call at all → grounded: false', async ({
    ask,
    fake,
  }) => {
    fake.reply({
      body: message([
        text(answer({ conversions: [{ amount: '1', from: 'EUR', to: 'USD', result: '1.09' }] })),
      ]),
    });
    expect((await ask('1 EUR in USD?')).body.grounded).toBe(false);
  });

  const broken: [string, () => object, number, string][] = [
    [
      'not JSON',
      () => ({ body: message([text('Sure! 100 EUR is about 16k yen.')]) }),
      502,
      'bad_model_output',
    ],
    [
      'JSON that breaks the schema',
      () => ({ body: message([text('{"answer":"x","extra":1}')]) }),
      502,
      'bad_model_output',
    ],
    [
      'cut off at max_tokens',
      () => ({ body: message([text('{"answer":"10')], 'max_tokens') }),
      502,
      'truncated',
    ],
  ];
  for (const [name, reply, status, code] of broken) {
    test(`model output ${name} → ${status} ${code}, nothing invented`, async ({ ask, fake }) => {
      fake.reply(reply());
      const res = await ask('100 EUR in JPY?');
      expect([res.status, res.body.error]).toEqual([status, code]);
      expect(res.body.answer).toBeUndefined();
    });
  }

  test('a safety refusal (stop_reason refusal) → 200 with refused: true', async ({ ask, fake }) => {
    fake.reply({ body: message([], 'refusal') });
    const res = await ask('Something the model refuses');
    expect([res.status, res.body.refused, res.body.conversions]).toEqual([200, true, []]);
  });

  test('the model calls tools forever → stopped after 4 turns with 502', async ({ ask, fake }) => {
    for (let i = 0; i < 4; i++)
      fake.reply({
        body: message([toolUse(`tu_${i}`, { amount: '1', from: 'EUR', to: 'USD' })], 'tool_use'),
      });
    const res = await ask('loop');
    expect([res.status, res.body.error, fake.requests.length]).toEqual([502, 'too_many_turns', 4]);
  });

  test('overloaded (529) twice, then fine: the SDK retries and the user sees one answer', async ({
    ask,
    fake,
  }) => {
    fake.reply(overloaded(), overloaded(), { body: message([text(answer({ answer: 'ok' }))]) });
    const res = await ask('Hi');
    expect([res.status, fake.requests.length]).toEqual([200, 3]);
  });

  test('overloaded every time → 503 with Retry-After, after exactly 1 + 2 retries', async ({ ask, fake }) => {
    fake.reply(overloaded(), overloaded(), overloaded());
    const res = await ask('Hi');
    expect([res.status, res.body.error, res.headers.get('retry-after'), fake.requests.length]).toEqual([
      503,
      'upstream_unavailable',
      '5',
      3,
    ]);
  });

  test('a model slower than the 1 s budget → 504 upstream_timeout', async ({ ask, fake }) => {
    const slow = { delayMs: 1_500, body: message([text(answer())]) };
    fake.reply(slow, slow, slow);
    const res = await ask('Hi');
    expect([res.status, res.body.error]).toEqual([504, 'upstream_timeout']);
  });

  test('a rejected key (401 upstream) → 502, and the key never reaches the caller', async ({ ask, fake }) => {
    fake.reply({
      status: 401,
      body: {
        type: 'error',
        error: { type: 'authentication_error', message: `invalid x-api-key ${FAKE_KEY}` },
      },
    });
    const res = await ask('Hi');
    expect([res.status, res.body.error]).toEqual([502, 'upstream_error']);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  const badInput: [string, unknown][] = [
    ['an empty question', ''],
    ['only spaces', '   '],
    ['2 001 characters', 'x'.repeat(2_001)],
    ['a number', 42],
  ];
  for (const [name, q] of badInput) {
    test(`${name} → 400 bad_question, the model is not called`, async ({ ask, fake }) => {
      const res = await ask(q);
      expect([res.status, res.body.error, fake.requests.length]).toEqual([400, 'bad_question', 0]);
    });
  }

  test('2 000 characters is accepted (boundary)', async ({ ask, fake }) => {
    fake.reply({ body: message([text(answer())]) });
    expect((await ask('x'.repeat(2_000))).status).toBe(200);
  });

  test('a body that is not JSON → 400 bad_json', async ({ ask }) => {
    expect((await ask('{raw}{oops')).body.error).toBe('bad_json');
  });
});
