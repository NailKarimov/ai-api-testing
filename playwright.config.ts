import { defineConfig } from '@playwright/test';
import type { TransportKind } from './src/mcp/fixtures';

const isCI = !!process.env.CI;

export default defineConfig<{ transport: TransportKind }>({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : 4,
  timeout: 30_000,
  reporter: [[isCI ? 'github' : 'list'], ['html', { open: 'never' }], ['allure-playwright']],
  projects: [
    // The same MCP suite over both transports (docs/mcp.md).
    { name: 'mcp-stdio', testDir: './tests/mcp', use: { transport: 'stdio' } },
    { name: 'mcp-http', testDir: './tests/mcp', use: { transport: 'http' } },
    // Streamable HTTP at the protocol level: sessions, auth, Origin, JSON-RPC errors.
    { name: 'mcp-http-protocol', testDir: './tests/mcp-http' },
    // MCP Inspector CLI as an independent client (SDK v2 against our v1 server).
    { name: 'inspector', testDir: './tests/inspector' },
  ],
});
