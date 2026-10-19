import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, expect, startHttp, TOKENS } from '../../src/mcp/fixtures';

const run = promisify(execFile);
const SERVER = [
  process.execPath,
  '--experimental-strip-types',
  '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
  path.resolve('services/fx-mcp/src/stdio.mts'),
];

/**
 * MCP Inspector (v2, MCP spec 2026-07-28) as an independent client: our server is built on SDK v1 (spec 2025-11-25),
 * so these tests are also a compatibility check across SDK generations.
 */
async function inspector(args: string[]) {
  const { stdout } = await run('npx', ['mcp-inspector', '--cli', ...args], { timeout: 60_000 }).catch(
    (e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }),
  );
  await test.info().attach(`mcp-inspector ${args.filter((a) => !a.includes(TOKENS.read)).join(' ')}`, {
    contentType: 'text/plain',
    body: stdout,
  });
  // The result is the first pretty-printed JSON object; a one-line error summary may follow it.
  const from = stdout.indexOf('{\n');
  return JSON.parse(stdout.slice(from, stdout.indexOf('\n}', from) + 2));
}

test.describe('MCP Inspector CLI', () => {
  test.describe.configure({ timeout: 90_000 });

  test('stdio: tools/list shows the four tools', { tag: '@smoke' }, async () => {
    const r = await inspector([...SERVER, '--method', 'tools/list']);
    expect(r.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'convert',
      'enable_currency',
      'list_rates',
      'slow_report',
    ]);
  });

  test('stdio: tools/call convert returns the same structured result as the SDK client', async () => {
    const r = await inspector([
      ...SERVER,
      '--method',
      'tools/call',
      '--tool-name',
      'convert',
      '--tool-arg',
      'amount="100"',
      'from=EUR',
      'to=JPY',
    ]);
    expect(r.structuredContent).toEqual({
      amount: '100',
      from: 'EUR',
      to: 'JPY',
      rate: '164.050000',
      result: '16405',
    });
  });

  test('finding: the CLI sends amount=100 as a number, and the schema rightly refuses it', async () => {
    const r = await inspector([
      ...SERVER,
      '--method',
      'tools/call',
      '--tool-name',
      'convert',
      '--tool-arg',
      'amount=100',
      'from=EUR',
      'to=JPY',
    ]);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('expected string, received number at amount');
  });

  test('HTTP: resources/read through the Inspector with a bearer token', async () => {
    const app = await startHttp();
    try {
      const r = await inspector([
        app.mcpUrl,
        '--header',
        `Authorization: Bearer ${TOKENS.read}`,
        '--method',
        'resources/read',
        '--uri',
        'fx://currencies',
      ]);
      expect(JSON.parse(r.contents[0].text)).toContainEqual({ code: 'JPY', minorUnits: 0 });
    } finally {
      await app.close();
    }
  });
});
