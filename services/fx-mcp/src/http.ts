import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from './server.ts';
import { RateTable } from './rates.ts';

/**
 * fx-mcp over Streamable HTTP (MCP spec 2025-11-25), the way a remote MCP server is deployed.
 *
 * - POST/GET/DELETE /mcp with an `Mcp-Session-Id` after initialize; unknown session → 404, none → 400.
 * - `Authorization: Bearer <token>`; without it 401 with `WWW-Authenticate: Bearer resource_metadata="…"`,
 *   pointing to the OAuth Protected Resource Metadata (RFC 9728) at /.well-known/oauth-protected-resource.
 * - Browsers' `Origin` is checked against an allow-list: DNS-rebinding protection (403 otherwise).
 * - Tokens carry scopes: fx:read for everything, fx:admin for enable_currency.
 */
export type HttpOptions = { tokens: Record<string, string[]>; allowedOrigins?: string[] };

const rpcError = (
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
};

async function readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function buildHttpServer(opts: HttpOptions) {
  const table = new RateTable(); // one state for all sessions
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const stats = { sessionsOpened: 0 };
  let base = 'http://127.0.0.1';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          resource: `${base}/mcp`,
          authorization_servers: ['https://auth.fx-mcp.test'],
          bearer_methods_supported: ['header'],
          scopes_supported: ['fx:read', 'fx:admin'],
        }),
      );
    }
    if (url.pathname !== '/mcp') return rpcError(res, 404, -32601, 'Not found');

    const origin = req.headers.origin;
    if (origin && !(opts.allowedOrigins ?? []).includes(origin)) {
      return rpcError(res, 403, -32000, `Origin ${origin} is not allowed`);
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const scopes = token ? opts.tokens[token] : undefined;
    if (!scopes) {
      return rpcError(res, 401, -32001, 'Unauthorized', {
        'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      });
    }
    (req as http.IncomingMessage & { auth?: unknown }).auth = { token, clientId: 'test-client', scopes };

    let body: unknown;
    if (req.method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) return rpcError(res, 400, -32700, 'Parse error');
      body = parsed.body;
    }

    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') {
      const t = sessions.get(sid);
      if (!t) return rpcError(res, 404, -32001, 'Session not found');
      return t.handleRequest(req, res, body);
    }
    if (req.method === 'POST' && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          stats.sessionsOpened++;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const { server: mcp } = buildServer(table);
      await mcp.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    return rpcError(res, 400, -32000, 'Bad Request: no valid session; send initialize first');
  });

  return {
    server,
    stats,
    sessions,
    table,
    listen: (port = 0) =>
      new Promise<string>((resolve) =>
        server.listen(port, '127.0.0.1', () => {
          base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          resolve(base);
        }),
      ),
    close: async () => {
      for (const t of sessions.values()) await t.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
