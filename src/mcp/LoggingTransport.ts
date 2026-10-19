import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Wraps a client transport and records every JSON-RPC message both ways, for the report and for assertions. */
export class LoggingTransport implements Transport {
  readonly log: { dir: '→' | '←'; at: number; msg: JSONRPCMessage }[] = [];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly inner: Transport) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = (e) => this.onerror?.(e);
    inner.onmessage = (m) => {
      this.log.push({ dir: '←', at: Date.now(), msg: m });
      this.onmessage?.(m);
    };
  }

  get sessionId() {
    return this.inner.sessionId;
  }

  setProtocolVersion(v: string) {
    this.inner.setProtocolVersion?.(v);
  }

  start() {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions) {
    this.log.push({ dir: '→', at: Date.now(), msg: message });
    return this.inner.send(message, options);
  }

  close() {
    return this.inner.close();
  }

  /** Notifications the server sent, by method. */
  notifications(method: string) {
    return this.log
      .filter((e) => e.dir === '←' && 'method' in e.msg && e.msg.method === method)
      .map((e) => (e.msg as { params?: Record<string, unknown> }).params ?? {});
  }

  transcript(): string {
    const t0 = this.log[0]?.at ?? 0;
    return this.log
      .map((e) => `${String(e.at - t0).padStart(5)} ms ${e.dir} ${JSON.stringify(e.msg).slice(0, 600)}`)
      .join('\n');
  }
}
