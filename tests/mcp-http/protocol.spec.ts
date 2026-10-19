import { test, expect, startHttp, TOKENS, ALLOWED_ORIGIN } from '../../src/mcp/fixtures';

/**
 * Streamable HTTP below the SDK: raw requests, so the tests see exactly what any client (or attacker) sees.
 * Each test starts its own server.
 */
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};

test.describe('MCP over Streamable HTTP', () => {
  let app: Awaited<ReturnType<typeof startHttp>>;
  test.beforeEach(async () => {
    app = await startHttp();
  });
  test.afterEach(async () => {
    await app.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(app.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKENS.read}`,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  /** Reads a JSON-RPC answer whether it came as JSON or as one SSE event. */
  const answer = async (res: Response) => {
    const t = await res.text();
    const data = t.startsWith('{')
      ? t
      : t
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6);
    return JSON.parse(data ?? '{}') as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  };
  const session = async () => {
    const res = await post(INIT);
    const id = res.headers.get('mcp-session-id')!;
    await res.text();
    await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'Mcp-Session-Id': id, 'MCP-Protocol-Version': '2025-11-25' },
    );
    return id;
  };

  test('initialize returns a session id; requests then carry it', { tag: '@smoke' }, async () => {
    const res = await post(INIT);
    const sid = res.headers.get('mcp-session-id');
    const body = await answer(res);

    expect(res.status).toBe(200);
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.result?.protocolVersion).toBe('2025-11-25');
  });

  test('no token → 401 pointing to the protected resource metadata (RFC 9728)', async () => {
    const res = await post(INIT, { Authorization: '' });
    const challenge = res.headers.get('www-authenticate')!;
    const metaUrl = /resource_metadata="([^"]+)"/.exec(challenge)![1]!;
    const meta = (await (await fetch(metaUrl)).json()) as Record<string, unknown>;

    expect(res.status).toBe(401);
    expect(meta).toMatchObject({ resource: app.mcpUrl, scopes_supported: ['fx:read', 'fx:admin'] });
    expect(meta.authorization_servers).toHaveLength(1);
  });

  test('a wrong token → 401, no session created', async () => {
    const res = await post(INIT, { Authorization: 'Bearer guess' });
    expect([res.status, res.headers.get('mcp-session-id')]).toEqual([401, null]);
    expect(app.stats.sessionsOpened).toBe(0);
  });

  test('DNS rebinding: a foreign Origin → 403; the allowed one passes', async () => {
    const evil = await post(INIT, { Origin: 'https://evil.example' });
    const ok = await post(INIT, { Origin: ALLOWED_ORIGIN });
    expect([evil.status, ok.status]).toEqual([403, 200]);
  });

  test('a request without a session → 400; with an unknown session → 404', async () => {
    const none = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const unknown = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'Mcp-Session-Id': crypto.randomUUID() },
    );
    expect([none.status, unknown.status]).toEqual([400, 404]);
  });

  test('DELETE ends the session: the next request with it → 404', async () => {
    const sid = await session();
    const del = await fetch(app.mcpUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${TOKENS.read}`,
        'Mcp-Session-Id': sid,
        'MCP-Protocol-Version': '2025-11-25',
      },
    });
    const after = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'Mcp-Session-Id': sid });
    expect([del.status, after.status]).toEqual([200, 404]);
  });

  test('two sessions are independent', async () => {
    const [a, b] = [await session(), await session()];
    expect(a).not.toBe(b);
    expect(app.sessions.size).toBe(2);
  });

  test('malformed JSON → 400 with JSON-RPC parse error -32700', async () => {
    const res = await post('{"jsonrpc":"2.0",');
    expect(res.status).toBe(400);
    expect((await answer(res)).error?.code).toBe(-32700);
  });

  test('an unknown method → -32601 method not found', async () => {
    const sid = await session();
    const res = await post(
      { jsonrpc: '2.0', id: 4, method: 'fx/steal' },
      { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-11-25' },
    );
    expect((await answer(res)).error?.code).toBe(-32601);
  });

  test('an unsupported MCP-Protocol-Version header → 400', async () => {
    const sid = await session();
    const res = await post(
      { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '1999-01-01' },
    );
    expect(res.status).toBe(400);
  });

  test('a client that does not accept text/event-stream → 406', async () => {
    const res = await post(INIT, { Accept: 'application/json' });
    expect(res.status).toBe(406);
  });

  test('a read-only token can call tools/list and convert, but the error for enable_currency names the scope', async () => {
    const sid = await session();
    const h = { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-11-25' };
    const list = await answer(await post({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, h));
    const call = await answer(
      await post(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'enable_currency', arguments: { code: 'NOK' } },
        },
        h,
      ),
    );

    expect((list.result?.tools as unknown[]).length).toBe(4);
    expect(call.result).toMatchObject({
      isError: true,
      content: [{ text: 'enable_currency requires the fx:admin scope' }],
    });
    expect(app.table.has('NOK')).toBe(false);
  });
});
