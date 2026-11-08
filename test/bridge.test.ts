import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { Bridge, DEFAULT_ORIGINS, NotConnected, originAllowed } from '../src/bridge.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

/** A page: connects, says hello and answers calls with `answer`. */
function page(port: number, opts: { origin?: string; code?: string; noOrigin?: boolean; protocol?: number; silent?: boolean; answer?: (m: { id: number; method: string; params: unknown }) => unknown } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts.noOrigin ? {} : { origin: opts.origin ?? 'https://mib2c.pqisa.eu' });
  const messages: { t: string; reason?: string }[] = [];
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', protocol: opts.protocol ?? PROTOCOL_VERSION, ...(opts.code ? { code: opts.code } : {}), app: { version: 'test', url: 'x' } }));
      resolve();
    });
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    messages.push(m);
    if (m.t === 'call' && !opts.silent) {
      try {
        ws.send(JSON.stringify({ t: 'result', id: m.id, ok: true, result: opts.answer?.(m) ?? null }));
      } catch (e) {
        ws.send(JSON.stringify({ t: 'result', id: m.id, ok: false, error: String(e) }));
      }
    }
  });
  const welcomed = () => new Promise<void>((r) => {
    const check = () => (messages.some((m) => m.t === 'welcome') ? r() : setTimeout(check, 10));
    check();
  });
  return { ws, messages, closed, opened, welcomed };
}

describe('Bridge', () => {
  let bridge: Bridge;
  before(async () => {
    bridge = new Bridge({ port: 0, origins: ['https://mib2c.pqisa.eu', 'http://localhost:*'], server: { name: 'mib2c-mcp', version: 'test' } });
    await bridge.start();
  });
  after(() => bridge.stop());

  it('says the page is not connected before one connects', async () => {
    await assert.rejects(bridge.call('get_state'), NotConnected);
  });

  it('lets the app connect without a code and runs calls on it', async () => {
    const p = page(bridge.port, { answer: (m) => ({ method: m.method, params: m.params }) });
    await p.welcomed();
    assert.ok(bridge.connected);
    assert.deepEqual(await bridge.call('navigate', { page: 'climate' }), { method: 'navigate', params: { page: 'climate' } });
    p.ws.close();
    await p.closed;
  });

  it('still lets in a 0.19.0 page (protocol 1, any pairing code)', async () => {
    const p = page(bridge.port, { protocol: 1, code: 'OLD0-CODE' });
    await p.welcomed();
    p.ws.close();
    await p.closed;
  });

  it('refuses another protocol version', async () => {
    const p = page(bridge.port, { protocol: PROTOCOL_VERSION + 1 });
    assert.equal(await p.closed, 4003);
    assert.match(p.messages[0]?.reason ?? '', /older than the app/);
  });

  it('refuses an origin that is not allowed, or none', async () => {
    await assert.rejects(page(bridge.port, { origin: 'https://evil.example' }).opened);
    await assert.rejects(page(bridge.port, { noOrigin: true }).opened);
  });

  it('lets a newer tab take over and fails the old tab\'s call', async () => {
    const first = page(bridge.port, { silent: true });
    await first.welcomed();
    const slowFails = assert.rejects(bridge.call('slow', {}, 5000), /Another tab/);
    const second = page(bridge.port, { answer: () => 'second' });
    await second.welcomed();
    await slowFails;
    assert.equal(await first.closed, 4005);
    assert.equal(await bridge.call('x'), 'second');
    second.ws.close();
    await second.closed;
  });

  it('fails calls when the page goes away', async () => {
    const p = page(bridge.port, { silent: true });
    await p.welcomed();
    const fails = assert.rejects(bridge.call('slow', {}, 5000), NotConnected);
    p.ws.close();
    await fails;
  });
});

describe('origins', () => {
  it('matches exact origins and wildcards', () => {
    const allowed = ['https://mib2c.pqisa.eu', 'http://localhost:*', 'https://*.ddev.site'];
    assert.ok(originAllowed('https://mib2c.pqisa.eu', allowed));
    assert.ok(originAllowed('https://pqisa.eu', DEFAULT_ORIGINS));
    assert.ok(!originAllowed('https://pqisa.eu.evil.example', DEFAULT_ORIGINS));
    assert.ok(!originAllowed('https://evil.pqisa.eu', DEFAULT_ORIGINS));
    assert.ok(originAllowed('http://localhost:3000', allowed));
    assert.ok(originAllowed('https://mib2-configurator.ddev.site', allowed));
    assert.ok(!originAllowed('https://mib2c.pqisa.eu.evil.example', allowed));
    assert.ok(!originAllowed('https://evil.example/https://mib2c.pqisa.eu', allowed));
    assert.ok(!originAllowed('http://localhost.evil.example:80', allowed));
    assert.ok(!originAllowed(undefined, allowed));
  });
});
