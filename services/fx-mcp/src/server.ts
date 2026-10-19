import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { z } from 'zod';
import { RateTable } from './rates.ts';

/**
 * fx-mcp: an MCP server written to be tested (docs/mcp.md). An AI assistant connects to it to convert money.
 *
 * Tools      convert (read-only, structured output), list_rates, slow_report (progress + cancellation),
 *            enable_currency (changes the server: resources/list_changed)
 * Resources  fx://currencies, fx://rates/{base} (template with completion)
 * Prompts    explain_conversion (arguments with completion)
 *
 * Business errors (an unknown currency) are tool results with isError: true, so a model can read them and correct
 * itself; malformed requests are JSON-RPC errors.
 */
export const SERVER_INFO = { name: 'fx-mcp', version: '1.0.0' };
const AMOUNT = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const CODE = /^[A-Z]{3}$/;

export function buildServer(table = new RateTable()) {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { logging: {} },
    instructions:
      'Converts amounts between currencies at a fixed reference table. Amounts are decimal strings.',
  });
  const unknown = (codes: string[]) => codes.filter((c) => !table.has(c));
  const jobs = { running: 0, finished: 0, cancelled: 0 };
  const toolError = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

  server.registerTool(
    'convert',
    {
      title: 'Convert an amount',
      description: 'Converts an amount from one currency to another at the reference rate.',
      inputSchema: {
        amount: z.string().regex(AMOUNT).describe('Decimal string with at most 2 places, e.g. "100.50"'),
        from: z.string().regex(CODE).describe('ISO 4217 code, e.g. "EUR"'),
        to: z.string().regex(CODE).describe('ISO 4217 code, e.g. "JPY"'),
      },
      outputSchema: {
        amount: z.string(),
        from: z.string(),
        to: z.string(),
        rate: z.string(),
        result: z.string(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ amount, from, to }) => {
      const bad = unknown([from, to]);
      if (bad.length)
        return toolError(`Unknown currency: ${bad.join(', ')}. Known: ${table.codes().join(', ')}.`);
      const places = amount.split('.')[1]?.length ?? 0;
      if (places > table.minorUnits(from)) {
        return toolError(`${from} has ${table.minorUnits(from)} decimal places; ${amount} has ${places}.`);
      }
      const out = { amount, from, to, rate: table.rate(from, to), result: table.convert(amount, from, to) };
      return {
        content: [{ type: 'text', text: `${amount} ${from} = ${out.result} ${to} (rate ${out.rate})` }],
        structuredContent: out,
      };
    },
  );

  server.registerTool(
    'list_rates',
    {
      title: 'List rates',
      description: 'Lists the rate of every known currency against a base currency.',
      inputSchema: { base: z.string().regex(CODE).default('EUR') },
      annotations: { readOnlyHint: true },
    },
    async ({ base }) => {
      if (!table.has(base)) return toolError(`Unknown currency: ${base}.`);
      const rates = Object.fromEntries(
        table
          .codes()
          .filter((c) => c !== base)
          .map((c) => [c, table.rate(base, c)]),
      );
      return { content: [{ type: 'text', text: JSON.stringify({ base, rates }) }] };
    },
  );

  server.registerTool(
    'slow_report',
    {
      title: 'Slow report',
      description: 'Builds a month-end report in steps, reporting progress; can be cancelled.',
      inputSchema: {
        steps: z.number().int().min(1).max(20).default(5),
        stepMs: z.number().int().min(0).max(2000).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ steps, stepMs }, extra) => {
      const token = extra._meta?.progressToken;
      jobs.running++;
      try {
        for (let i = 1; i <= steps; i++) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, stepMs);
            extra.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('cancelled'));
            });
          });
          if (token !== undefined) {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress: i, total: steps, message: `step ${i} of ${steps}` },
            });
          }
        }
        jobs.finished++;
        return { content: [{ type: 'text', text: `report ready after ${steps} steps` }] };
      } catch (e) {
        jobs.cancelled++;
        throw e;
      } finally {
        jobs.running--;
      }
    },
  );

  server.registerTool(
    'enable_currency',
    {
      title: 'Enable a currency',
      description: 'Switches on a dormant currency. Changes what the server offers.',
      inputSchema: { code: z.string().regex(CODE) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ code }, extra) => {
      // Over HTTP the caller is known (authInfo) and needs fx:admin. Over stdio the user started the server
      // themselves: a local trust boundary, no token.
      if (extra.authInfo && !extra.authInfo.scopes.includes('fx:admin')) {
        return toolError('enable_currency requires the fx:admin scope');
      }
      if (table.has(code)) return { content: [{ type: 'text', text: `${code} is already enabled` }] };
      if (!table.enable(code)) return toolError(`No dormant currency ${code}.`);
      server.sendResourceListChanged();
      return { content: [{ type: 'text', text: `${code} enabled` }] };
    },
  );

  server.registerResource(
    'currencies',
    'fx://currencies',
    {
      title: 'Currencies',
      description: 'Known currencies and their minor units',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(table.codes().map((code) => ({ code, minorUnits: table.minorUnits(code) }))),
        },
      ],
    }),
  );

  // Operational view: how many reports are running. Lets an operator (and a test) see that cancelled work stops.
  server.registerResource(
    'jobs',
    'fx://server/jobs',
    {
      title: 'Running jobs',
      description: 'Reports running, finished and cancelled',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(jobs) }],
    }),
  );

  server.registerResource(
    'rates',
    new ResourceTemplate('fx://rates/{base}', {
      list: async () => ({
        resources: table
          .codes()
          .map((c) => ({ uri: `fx://rates/${c}`, name: `rates-${c}`, mimeType: 'application/json' })),
      }),
      complete: { base: (value) => table.codes().filter((c) => c.startsWith(value.toUpperCase())) },
    }),
    {
      title: 'Rates against a base',
      description: 'Every rate against one base currency',
      mimeType: 'application/json',
    },
    async (uri, { base }) => {
      const b = String(base);
      if (!CODE.test(b) || !table.has(b)) throw new Error(`Resource ${uri.href} not found`);
      const rates = Object.fromEntries(
        table
          .codes()
          .filter((c) => c !== b)
          .map((c) => [c, table.rate(b, c)]),
      );
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ base: b, rates }) }],
      };
    },
  );

  const currencyArg = () =>
    completable(z.string().regex(CODE), (value) =>
      table.codes().filter((c) => c.startsWith(value.toUpperCase())),
    );
  server.registerPrompt(
    'explain_conversion',
    {
      title: 'Explain a conversion',
      description: 'Asks the model to explain a conversion to a customer in plain words.',
      argsSchema: { amount: z.string().regex(AMOUNT), from: currencyArg(), to: currencyArg() },
    },
    ({ amount, from, to }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Explain to a bank customer, in two sentences, what ${amount} ${from} is worth in ${to}. Use the convert tool for the number; do not guess it.`,
          },
        },
      ],
    }),
  );

  return { server, table };
}
