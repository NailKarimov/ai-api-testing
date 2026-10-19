import { test, expect, TOKENS } from '../../src/mcp/fixtures';

/** Resources (data the client can read) and prompts (templates the user can pick), over both transports. */
test.describe('MCP resources', () => {
  test(
    'resources/list: the static resource and one entry per base currency',
    { tag: '@smoke' },
    async ({ connect }) => {
      const { client } = await connect();
      const uris = (await client.listResources()).resources.map((r) => r.uri);
      expect(uris).toEqual(
        expect.arrayContaining(['fx://currencies', 'fx://server/jobs', 'fx://rates/EUR', 'fx://rates/JPY']),
      );
    },
  );

  test('resources/templates/list announces fx://rates/{base}', async ({ connect }) => {
    const { client } = await connect();
    const t = (await client.listResourceTemplates()).resourceTemplates;
    expect(t.map((x) => x.uriTemplate)).toEqual(['fx://rates/{base}']);
  });

  test('fx://currencies: JSON with ISO 4217 minor units (JPY 0)', async ({ connect }) => {
    const { client } = await connect();
    const r = await client.readResource({ uri: 'fx://currencies' });
    const c = r.contents[0]! as { mimeType: string; text: string };

    expect(c.mimeType).toBe('application/json');
    expect(JSON.parse(c.text)).toContainEqual({ code: 'JPY', minorUnits: 0 });
    expect(JSON.parse(c.text)).toContainEqual({ code: 'EUR', minorUnits: 2 });
  });

  test('fx://rates/USD: every other currency against USD, and the same rate the convert tool uses', async ({
    connect,
  }) => {
    const { client } = await connect();
    const r = await client.readResource({ uri: 'fx://rates/USD' });
    const body = JSON.parse((r.contents[0] as { text: string }).text) as {
      base: string;
      rates: Record<string, string>;
    };
    const conv = (await client.callTool({
      name: 'convert',
      arguments: { amount: '1', from: 'USD', to: 'JPY' },
    })) as unknown as {
      structuredContent: { rate: string };
    };

    expect(body.base).toBe('USD');
    expect(Object.keys(body.rates).sort()).toEqual(['CHF', 'EUR', 'GBP', 'JPY', 'SEK']);
    expect(body.rates.JPY).toBe(conv.structuredContent.rate); // two interfaces, one truth
  });

  const missing = [
    'fx://rates/XYZ',
    'fx://rates/usd',
    'fx://rates/../secrets',
    'fx://nothing',
    'file:///etc/passwd',
  ];
  for (const uri of missing) {
    test(`reading ${uri} → an error, no content`, async ({ connect }) => {
      const { client } = await connect();
      const err = await client.readResource({ uri }).then(
        () => undefined,
        (e: { code?: number; message: string }) => e,
      );
      expect(err).toBeDefined();
      expect(err!.message).not.toMatch(/at .+\.ts:\d+/); // no stack trace for the client
    });
  }

  test('completion: "U" for {base} suggests USD', async ({ connect }) => {
    const { client } = await connect();
    const r = await client.complete({
      ref: { type: 'ref/resource', uri: 'fx://rates/{base}' },
      argument: { name: 'base', value: 'U' },
    });
    expect(r.completion.values).toEqual(['USD']);
  });
});

test.describe('MCP prompts', () => {
  test('prompts/list: explain_conversion with three required arguments', async ({ connect }) => {
    const { client } = await connect();
    const p = (await client.listPrompts()).prompts;

    expect(p.map((x) => x.name)).toEqual(['explain_conversion']);
    expect(p[0]!.arguments!.map((a) => [a.name, a.required])).toEqual([
      ['amount', true],
      ['from', true],
      ['to', true],
    ]);
  });

  test('prompts/get fills the template and tells the model to use the tool, not to guess', async ({
    connect,
  }) => {
    const { client } = await connect();
    const r = await client.getPrompt({
      name: 'explain_conversion',
      arguments: { amount: '100', from: 'EUR', to: 'JPY' },
    });
    const msg = r.messages[0]!;

    expect(msg.role).toBe('user');
    expect((msg.content as { text: string }).text).toContain('100 EUR');
    expect((msg.content as { text: string }).text).toContain('Use the convert tool');
  });

  test('prompts/get without a required argument → Invalid params (-32602)', async ({ connect }) => {
    const { client } = await connect();
    const err = await client
      .getPrompt({ name: 'explain_conversion', arguments: { amount: '100', from: 'EUR' } })
      .catch((e: { code?: number }) => e);
    expect((err as { code?: number }).code).toBe(-32602);
  });

  test('completion: "G" for the prompt argument "to" suggests GBP', async ({ connect }) => {
    const { client } = await connect();
    const r = await client.complete({
      ref: { type: 'ref/prompt', name: 'explain_conversion' },
      argument: { name: 'to', value: 'g' },
    });
    expect(r.completion.values).toEqual(['GBP']);
  });
});

test.describe('MCP trust boundary', () => {
  test('enable_currency: allowed over stdio (local user), needs fx:admin over HTTP', async ({
    connect,
    transport,
  }) => {
    const { client } = await connect({ token: TOKENS.read });
    const r = (await client.callTool({ name: 'enable_currency', arguments: { code: 'NOK' } })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    if (transport === 'stdio')
      expect([r.isError ?? false, r.content[0]!.text]).toEqual([false, 'NOK enabled']);
    else
      expect([r.isError, r.content[0]!.text]).toEqual([true, 'enable_currency requires the fx:admin scope']);
  });
});
