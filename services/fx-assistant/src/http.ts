import http from 'node:http';
import { AssistantError, buildAssistant, type AssistantOptions } from './assistant.ts';

/**
 * POST /v1/answer { "question": "…" } → the checked answer. Errors are JSON { error, message } with a status that
 * tells the caller what to do: 400 fix the request, 502 the model misbehaved, 503 retry later, 504 timeout.
 */
export function buildAssistantServer(opts: AssistantOptions) {
  const assistant = buildAssistant(opts);
  const send = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
    if (req.method !== 'POST' || url.pathname !== '/v1/answer')
      return send(res, 404, { error: 'not_found', message: 'POST /v1/answer' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { question?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return send(res, 400, { error: 'bad_json', message: 'the body is not JSON' });
    }
    const q = typeof body.question === 'string' ? body.question.trim() : '';
    if (q.length < 1 || q.length > 2_000)
      return send(res, 400, { error: 'bad_question', message: 'question must be 1–2000 characters' });
    const started = Date.now();
    try {
      const result = await assistant.ask(q);
      send(res, 200, { ...result, latency_ms: Date.now() - started });
    } catch (e) {
      if (e instanceof AssistantError) {
        return send(
          res,
          e.status,
          { error: e.code, message: e.message },
          e.status === 503 ? { 'Retry-After': '5' } : {},
        );
      }
      send(res, 500, { error: 'internal', message: 'internal error' });
    }
  });
  return {
    server,
    listen: (port = 0) =>
      new Promise<string>((resolve) =>
        server.listen(port, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
        ),
      ),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
