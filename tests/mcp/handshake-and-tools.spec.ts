import { z } from 'zod';
import { test, expect } from '../../src/mcp/fixtures';

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, string>;
};
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

/** The handshake and the tools, over both transports (projects mcp-stdio and mcp-http). */
test.describe('MCP handshake', () => {
  test(
    'initialize: server identity, protocol version, capabilities, instructions',
    { tag: '@smoke' },
    async ({ connect }) => {
      const { client } = await connect();

      expect(client.getServerVersion()).toEqual({ name: 'fx-mcp', version: '1.0.0' });
      expect(client.getServerCapabilities()).toMatchObject({
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
      });
      expect(client.getInstructions()).toContain('decimal strings');
    },
  );

  test('the negotiated protocol version is 2025-11-25', async ({ connect }) => {
    const { wire } = await connect();
    const init = wire.log.find((e) => e.dir === '←' && 'result' in e.msg)!.msg as unknown as {
      result: { protocolVersion: string };
    };
    expect(init.result.protocolVersion).toBe('2025-11-25');
  });
});

test.describe('MCP tools', () => {
  test('tools/list: four tools, each with an object input schema; convert declares its output', async ({
    connect,
  }) => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'convert',
      'enable_currency',
      'list_rates',
      'slow_report',
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    const convert = tools.find((t) => t.name === 'convert')!;
    expect(convert.inputSchema.required).toEqual(['amount', 'from', 'to']);
    expect(convert.outputSchema?.required).toEqual(['amount', 'from', 'to', 'rate', 'result']);
  });

  test('annotations tell the client which tools only read and which change state', async ({ connect }) => {
    const { client } = await connect();
    const byName = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));

    expect(byName.convert).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(byName.list_rates?.readOnlyHint).toBe(true);
    expect(byName.enable_currency?.readOnlyHint).toBe(false);
  });

  test('tool metadata is safe to show a model: no hidden characters or instructions (tool poisoning)', async ({
    connect,
  }) => {
    const { client } = await connect();
    const suspicious =
      /ignore (all|previous)|system prompt|<\s*(important|system)|do not tell|exfiltrat|send .* to http/i;
    for (const t of (await client.listTools()).tools) {
      const meta = JSON.stringify([t.name, t.title, t.description, t.inputSchema]);
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(meta).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/); // zero-width and bidi controls
      expect(meta).not.toMatch(suspicious);
      expect(t.description!.length).toBeLessThan(300);
    }
  });

  // Expected values from an independent oracle (Python Decimal, ROUND_HALF_UP), not from the code under test.
  const conversions: [string, string, string, string, string][] = [
    ['100', 'EUR', 'USD', '108.50', '1.085000'],
    ['100', 'EUR', 'JPY', '16405', '164.050000'], // JPY has no minor units
    ['1', 'JPY', 'EUR', '0.01', '0.006096'],
    ['0.01', 'USD', 'JPY', '2', '151.198157'], // 1.51 rounds up
    ['250.75', 'GBP', 'CHF', '280.70', '1.119438'],
    ['1000000', 'SEK', 'JPY', '14365149', '14.365149'],
    ['0', 'EUR', 'USD', '0.00', '1.085000'],
    ['9999999999', 'JPY', 'GBP', '52057299.60', '0.005206'], // largest amount
  ];
  for (const [amount, from, to, result, rate] of conversions) {
    test(`convert ${amount} ${from} → ${to} = ${result}`, async ({ connect }) => {
      const { client } = await connect();
      const r = (await client.callTool({ name: 'convert', arguments: { amount, from, to } })) as ToolResult;

      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toEqual({ amount, from, to, rate, result });
      expect(text(r)).toBe(`${amount} ${from} = ${result} ${to} (rate ${rate})`); // text and structure agree
    });
  }

  test('structured output matches the declared output schema', async ({ connect }) => {
    const { client } = await connect();
    const r = (await client.callTool({
      name: 'convert',
      arguments: { amount: '5', from: 'EUR', to: 'GBP' },
    })) as ToolResult;
    const schema = z
      .object({ amount: z.string(), from: z.string(), to: z.string(), rate: z.string(), result: z.string() })
      .strict();
    expect(() => schema.parse(r.structuredContent)).not.toThrow();
  });

  test('an unknown currency is a tool error the model can read and fix, not a protocol error', async ({
    connect,
  }) => {
    const { client } = await connect();
    const r = (await client.callTool({
      name: 'convert',
      arguments: { amount: '1', from: 'EUR', to: 'XYZ' },
    })) as ToolResult;

    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Unknown currency: XYZ. Known: CHF, EUR, GBP, JPY, SEK, USD.');
    expect(r.structuredContent).toBeUndefined();
  });

  test('more decimals than the currency has → tool error (JPY has none)', async ({ connect }) => {
    const { client } = await connect();
    const r = (await client.callTool({
      name: 'convert',
      arguments: { amount: '1.5', from: 'JPY', to: 'EUR' },
    })) as ToolResult;
    expect([r.isError, text(r)]).toEqual([true, 'JPY has 0 decimal places; 1.5 has 1.']);
  });

  const invalidArgs: [string, Record<string, unknown>][] = [
    ['an amount in exponent form', { amount: '1e5', from: 'EUR', to: 'USD' }],
    ['three decimals', { amount: '1.005', from: 'EUR', to: 'USD' }],
    ['a negative amount', { amount: '-1', from: 'EUR', to: 'USD' }],
    ['a number instead of a string', { amount: 100, from: 'EUR', to: 'USD' }],
    ['a lower-case code', { amount: '1', from: 'eur', to: 'USD' }],
    ['a missing argument', { amount: '1', from: 'EUR' }],
  ];
  for (const [name, args] of invalidArgs) {
    test(`schema violation: ${name} → rejected with the field named, nothing computed`, async ({
      connect,
    }) => {
      const { client } = await connect();
      const outcome = await client
        .callTool({ name: 'convert', arguments: args })
        .then((r) => ({ kind: 'result' as const, r: r as ToolResult }))
        .catch((e: { code?: number; message: string }) => ({ kind: 'error' as const, e }));

      // Spec 2025-11-25: input validation errors are reported as tool errors, so the model can retry.
      expect(outcome.kind).toBe('result');
      if (outcome.kind !== 'result') return;
      expect(outcome.r.isError).toBe(true);
      expect(text(outcome.r)).toMatch(/validation/i);
      expect(outcome.r.structuredContent).toBeUndefined();
    });
  }

  test('an unknown tool → a tool error naming it', async ({ connect }) => {
    const { client } = await connect();
    const outcome = await client
      .callTool({ name: 'transfer_money', arguments: {} })
      .then((r) => text(r as ToolResult))
      .catch((e: Error) => e.message);
    expect(outcome).toContain('transfer_money');
  });

  test('progress: one notification per step, in order, all before the result', async ({ connect }) => {
    const { client, wire } = await connect();
    const r = (await client.callTool(
      { name: 'slow_report', arguments: { steps: 5, stepMs: 20 } },
      undefined,
      {
        onprogress: () => {},
      },
    )) as ToolResult;

    expect(text(r)).toBe('report ready after 5 steps');
    // The oracle is the wire, not the SDK callback: SDK 1.32 can drop a progress notification that arrives in the
    // same chunk as the result (finding MCP-1 in docs/mcp.md). The server's duty is to send them, in order, first.
    const progress = wire.notifications('notifications/progress');
    expect(progress.map((p) => [p.progress, p.total])).toEqual([1, 2, 3, 4, 5].map((n) => [n, 5]));
    const lastProgress = wire.log.findLastIndex(
      (e) => 'method' in e.msg && e.msg.method === 'notifications/progress',
    );
    const result = wire.log.findIndex(
      (e) => e.dir === '←' && 'id' in e.msg && e.msg.id === 1 && 'result' in e.msg,
    );
    expect(lastProgress).toBeLessThan(result);
  });

  test('cancellation: the client aborts, the server stops working, the session stays usable', async ({
    connect,
  }) => {
    const { client, wire } = await connect();
    const ac = new AbortController();
    setTimeout(() => ac.abort('user pressed stop'), 250);
    const started = Date.now();
    const outcome = await client
      .callTool({ name: 'slow_report', arguments: { steps: 20, stepMs: 100 } }, undefined, {
        signal: ac.signal,
        onprogress: () => {},
      })
      .then(() => 'finished')
      .catch(() => 'aborted');

    expect(outcome).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(1_000); // not the 4 s of the full report
    const cancelledAt = wire.log.findIndex(
      (e) => e.dir === '→' && 'method' in e.msg && e.msg.method === 'notifications/cancelled',
    );
    expect(cancelledAt).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 500)); // five more steps' worth of time
    // the server's evidence: at most one step that was already in flight, then silence
    const progressAfter = wire.log
      .slice(cancelledAt)
      .filter((e) => 'method' in e.msg && e.msg.method === 'notifications/progress');
    expect(progressAfter.length).toBeLessThanOrEqual(1);
    // and the server says so itself: nothing left running, one job cancelled
    const jobs = async () =>
      JSON.parse(
        ((await client.readResource({ uri: 'fx://server/jobs' })).contents[0] as { text: string }).text,
      );
    await expect.poll(jobs).toMatchObject({ running: 0, cancelled: 1, finished: 0 });
    const r = (await client.callTool({
      name: 'convert',
      arguments: { amount: '1', from: 'EUR', to: 'USD' },
    })) as ToolResult;
    expect(r.isError).toBeFalsy();
  });

  test('a client-side timeout ends a long call with RequestTimeout (-32001)', async ({ connect }) => {
    const { client } = await connect();
    const err = await client
      .callTool({ name: 'slow_report', arguments: { steps: 10, stepMs: 200 } }, undefined, { timeout: 200 })
      .catch((e: { code?: number }) => e);
    expect((err as { code?: number }).code).toBe(-32001);
  });

  test('enable_currency changes the server and announces it: resources/list_changed, then NOK is listed', async ({
    connect,
    transport,
  }) => {
    const { client, wire } = await connect();
    const r = (await client.callTool({ name: 'enable_currency', arguments: { code: 'NOK' } })) as ToolResult;

    expect(text(r)).toBe('NOK enabled');
    await expect.poll(() => wire.notifications('notifications/resources/list_changed').length).toBe(1);
    const uris = (await client.listResources()).resources.map((x) => x.uri);
    expect(uris).toContain('fx://rates/NOK');
    void transport;
  });
});
