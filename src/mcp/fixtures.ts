import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test as base, expect } from '../fixtures';
import { buildHttpServer } from '../../services/fx-mcp/src/http.ts';
import { LoggingTransport } from './LoggingTransport';

/** Test values of the in-process server; they guard nothing outside a test run. */
export const TOKENS = { read: 'test-only-read-token', admin: 'test-only-admin-token' } as const;
export const ALLOWED_ORIGIN = 'http://localhost:6274';
export type TransportKind = 'stdio' | 'http';

export async function startHttp() {
  const app = buildHttpServer({
    tokens: { [TOKENS.read]: ['fx:read'], [TOKENS.admin]: ['fx:read', 'fx:admin'] },
    allowedOrigins: [ALLOWED_ORIGIN],
  });
  const baseUrl = await app.listen();
  return { ...app, baseUrl, mcpUrl: `${baseUrl}/mcp` };
}

export type Connected = { client: Client; wire: LoggingTransport; kind: TransportKind };

/**
 * The same MCP tests run over both transports (Playwright projects mcp-stdio and mcp-http): `connect()` gives an
 * initialized SDK client. stdio spawns the server as a child process, as a desktop assistant would; HTTP starts a
 * fresh in-process server per test. Every connection's JSON-RPC transcript goes to the report.
 */
export const test = base.extend<{
  transport: TransportKind;
  connect: (opts?: { token?: string }) => Promise<Connected>;
  http: Awaited<ReturnType<typeof startHttp>>;
}>({
  transport: ['stdio', { option: true }],
  // eslint-disable-next-line no-empty-pattern
  http: async ({}, use) => {
    const app = await startHttp();
    await use(app);
    await app.close();
  },
  connect: async ({ transport, http }, use, testInfo) => {
    const opened: Connected[] = [];
    await use(async (opts = {}) => {
      const inner =
        transport === 'stdio'
          ? new StdioClientTransport({
              command: process.execPath,
              args: [
                '--experimental-strip-types',
                '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
                path.resolve('services/fx-mcp/src/stdio.mts'),
              ],
              stderr: 'pipe',
            })
          : new StreamableHTTPClientTransport(new URL(http.mcpUrl), {
              requestInit: { headers: { Authorization: `Bearer ${opts.token ?? TOKENS.admin}` } },
            });
      const wire = new LoggingTransport(inner);
      const client = new Client({ name: 'qa-tests', version: '1.0.0' }, { capabilities: {} });
      await client.connect(wire);
      const c = { client, wire, kind: transport };
      opened.push(c);
      return c;
    });
    for (const [i, c] of opened.entries()) {
      await c.client.close().catch(() => {});
      await testInfo.attach(`MCP ${transport} transcript ${i + 1}`, {
        contentType: 'text/plain',
        body: c.wire.transcript().replaceAll(TOKENS.read, '***').replaceAll(TOKENS.admin, '***'),
      });
    }
  },
});

export { expect };
