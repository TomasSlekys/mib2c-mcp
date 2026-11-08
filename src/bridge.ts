// The WebSocket end the MIB2 Configurator page connects to: on 127.0.0.1 only, and only from an allowed origin
// (the browser sets Origin; a web page can't fake it). No pairing code: browsers also ask the user before a public
// site may reach 127.0.0.1 at all. One page at a time (a newer tab takes over). Tool calls go to that page and wait
// for its answer.

import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { type Call, type Hello, PROTOCOL_VERSION, type Rejected, type Result, type Welcome } from './protocol.js';

export interface BridgeOptions {
  port: number;
  /** Origins allowed to connect: exact ("https://pqisa.eu") or with "*" for any part ("http://localhost:*"). */
  origins: string[];
  server: { name: string; version: string };
  log?: (line: string) => void;
}

export interface PageInfo {
  version: string;
  url: string;
  origin: string;
  since: Date;
}

/** The page isn't connected, or went away during the call. */
export class NotConnected extends Error {}

// pqisa.eu serves the app at /mib2c/ (behind its Discord sign-in); mib2c.pqisa.eu is its old address.
export const DEFAULT_ORIGINS = ['https://pqisa.eu', 'https://mib2c.pqisa.eu', 'http://localhost:*', 'http://127.0.0.1:*', 'https://*.ddev.site'];

export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  return allowed.some((pattern) => {
    if (pattern === '*') return true;
    const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('[^/]*')}$`, 'i');
    return re.test(origin);
  });
}

export class Bridge {
  private wss: WebSocketServer | null = null;
  private page: WebSocket | null = null;
  private pageInfo: PageInfo | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** Why listening failed (the port is taken, most likely by another mib2c-mcp). */
  listenError: string | null = null;
  port: number;

  constructor(private opts: BridgeOptions) {
    this.port = opts.port;
  }

  get connected(): PageInfo | null {
    return this.page && this.page.readyState === WebSocket.OPEN ? this.pageInfo : null;
  }

  private log(line: string) {
    this.opts.log?.(line);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.opts.port,
        maxPayload: 64 * 1024 * 1024,
        verifyClient: ({ origin }: { origin?: string }) => {
          const ok = originAllowed(origin, this.opts.origins);
          if (!ok) this.log(`Refused a connection from ${origin ?? 'no origin'} (not in the allowed origins; see MIB2C_ORIGINS).`);
          return ok;
        },
      });
      this.wss = wss;
      wss.on('listening', () => {
        this.port = (wss.address() as AddressInfo).port;
        this.listenError = null;
        this.log(`Waiting for the MIB2 Configurator page on ws://127.0.0.1:${this.port}.`);
        resolve();
      });
      wss.on('error', (err: NodeJS.ErrnoException) => {
        this.listenError =
          err.code === 'EADDRINUSE'
            ? `Port ${this.opts.port} is taken, most likely by another mib2c-mcp (another AI app or session). Close that one, or start this one with MIB2C_PORT set to another port and enter that port in the app.`
            : `Couldn't listen on port ${this.opts.port}: ${err.message}`;
        this.log(this.listenError);
        resolve();
      });
      wss.on('connection', (socket, req) => this.accept(socket, req.headers.origin ?? ''));
    });
  }

  async stop() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new NotConnected('The server is stopping.'));
    }
    this.pending.clear();
    this.page?.close();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }

  private accept(socket: WebSocket, origin: string) {
    const send = (m: Welcome | Rejected | Call) => socket.send(JSON.stringify(m));
    const hello = setTimeout(() => socket.close(4001, 'No hello'), 5000);
    socket.once('message', (data) => {
      clearTimeout(hello);
      let msg: Hello;
      try {
        msg = JSON.parse(String(data));
      } catch {
        socket.close(4002, 'Bad hello');
        return;
      }
      if (msg.t !== 'hello') return socket.close(4002, 'Bad hello');
      // Protocol 1 (app 0.19.0) only added a pairing code, which is no longer checked.
      if (msg.protocol !== PROTOCOL_VERSION && msg.protocol !== 1) {
        send({
          t: 'rejected',
          reason:
            msg.protocol > PROTOCOL_VERSION
              ? 'This mib2c-mcp is older than the app: update it (npx fetches the latest when your AI app restarts it).'
              : 'The app is older than this mib2c-mcp: reload the page.',
        });
        return socket.close(4003, 'Protocol');
      }
      // A newer tab takes over: the old one's calls fail and it hears why.
      if (this.page && this.page !== socket) {
        this.dropPending('Another tab connected and took over.');
        this.page.close(4005, 'Another tab connected');
      }
      this.page = socket;
      this.pageInfo = { version: String(msg.app?.version ?? '?'), url: String(msg.app?.url ?? ''), origin, since: new Date() };
      send({ t: 'welcome', server: this.opts.server });
      this.log(`The page connected (${origin}, app ${this.pageInfo.version}).`);
      socket.on('message', (raw) => this.onResult(raw.toString()));
      socket.on('close', () => {
        if (this.page !== socket) return;
        this.page = null;
        this.pageInfo = null;
        this.dropPending('The page went away (closed, reloaded or disconnected) before answering.');
        this.log('The page disconnected.');
      });
    });
  }

  private onResult(raw: string) {
    let msg: Result;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t !== 'result') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  private dropPending(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new NotConnected(reason));
    }
    this.pending.clear();
  }

  /** Runs a command on the page; rejects with NotConnected when there is no page, or with the page's error. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const page = this.page;
    if (!page || page.readyState !== WebSocket.OPEN) return Promise.reject(new NotConnected(''));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The page didn't answer "${method}" within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const call: Call = { t: 'call', id, method, params };
      page.send(JSON.stringify(call));
    });
  }
}
