import http from 'node:http';

/**
 * A stand-in for the Anthropic Messages API on localhost. The real SDK talks to it (baseURL), so the tests cover
 * the service's real integration code without a key and without cost. Each test scripts the replies in order and
 * reads back what the service sent.
 */
export type Reply = { status?: number; body?: unknown; delayMs?: number; headers?: Record<string, string> };
export type Recorded = { body: Record<string, unknown>; headers: http.IncomingHttpHeaders };

export const message = (
  content: unknown[],
  stop_reason = 'end_turn',
  usage = { input_tokens: 120, output_tokens: 40 },
) => ({
  id: `msg_${Math.random().toString(36).slice(2, 10)}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage,
});
export const text = (t: string) => ({ type: 'text', text: t });
export const toolUse = (id: string, input: Record<string, string>, name = 'convert') => ({
  type: 'tool_use',
  id,
  name,
  input,
});
export const answer = (a: Partial<Record<string, unknown>> = {}) =>
  JSON.stringify({ answer: 'ok', conversions: [], refused: false, needs_clarification: false, ...a });
export const overloaded = (retryMs = 10): Reply => ({
  status: 529,
  body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  headers: { 'retry-after-ms': String(retryMs) },
});

export async function startFakeAnthropic() {
  const queue: (Reply | ((r: Recorded) => Reply))[] = [];
  const requests: Recorded[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rec: Recorded = {
      body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      headers: req.headers,
    };
    requests.push(rec);
    const next = queue.shift();
    const reply: Reply =
      typeof next === 'function'
        ? next(rec)
        : (next ?? {
            status: 500,
            body: { type: 'error', error: { type: 'api_error', message: 'no scripted reply left' } },
          });
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    requests,
    /** Scripts the next replies, in order. */
    reply: (...r: (Reply | ((rec: Recorded) => Reply))[]) => queue.push(...r),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
