import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { Bridge, NotConnected, originAllowed } from '../src/bridge.js';
import { pairingCode } from '../src/pairing.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

const CODE = 'ABCD-2345';

/** A page: connects, says hello and answers calls with `answer`. */
function page(port: number, opts: { origin?: string; code?: string; protocol?: number; silent?: boolean; answer?: (m: { id: number; method: string; params: unknown }) => unknown } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: opts.origin ?? 'https://mib2c.pqisa.eu' });
  const messages: { t: string; reason?: string }[] = [];
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', protocol: opts.protocol ?? PROTOCOL_VERSION, code: opts.code ?? CODE, app: { version: 'test', url: 'x' } }));
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
    bridge = new Bridge({ port: 0, code: CODE, origins: ['https://mib2c.pqisa.eu', 'http://localhost:*'], server: { name: 'mib2c-mcp', version: 'test' } });
    await bridge.start();
  });
  after(() => bridge.stop());

  it('says the page is not connected before one pairs', async () => {
    await assert.rejects(bridge.call('get_state'), NotConnected);
  });

  it('pairs a page and runs calls on it', async () => {
    const p = page(bridge.port, { answer: (m) => ({ method: m.method, params: m.params }) });
    await p.welcomed();
    assert.ok(bridge.connected);
    assert.deepEqual(await bridge.call('navigate', { page: 'climate' }), { method: 'navigate', params: { page: 'climate' } });
    p.ws.close();
    await p.closed;
  });

  it('accepts the code in any case and with spaces', async () => {
    const p = page(bridge.port, { code: ' abcd-2345 ' });
    await p.welcomed();
    p.ws.close();
    await p.closed;
  });

  it('refuses a wrong code', async () => {
    const p = page(bridge.port, { code: 'WRONG-0000' });
    assert.equal(await p.closed, 4004);
    assert.equal(p.messages[0]?.t, 'rejected');
  });

  it('refuses another protocol version', async () => {
    const p = page(bridge.port, { protocol: PROTOCOL_VERSION + 1 });
    assert.equal(await p.closed, 4003);
    assert.match(p.messages[0]?.reason ?? '', /older than the app/);
  });

  it('refuses an origin that is not allowed', async () => {
    const p = page(bridge.port, { origin: 'https://evil.example' });
    await assert.rejects(p.opened);
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
    assert.ok(originAllowed('http://localhost:3000', allowed));
    assert.ok(originAllowed('https://mib2-configurator.ddev.site', allowed));
    assert.ok(!originAllowed('https://mib2c.pqisa.eu.evil.example', allowed));
    assert.ok(!originAllowed('https://evil.example/https://mib2c.pqisa.eu', allowed));
    assert.ok(!originAllowed('http://localhost.evil.example:80', allowed));
    assert.ok(!originAllowed(undefined, allowed));
  });
});

describe('pairing code', () => {
  it('is kept between runs until a new one is asked for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mib2c-'));
    const code = pairingCode(dir);
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(pairingCode(dir), code);
    assert.equal(JSON.parse(readFileSync(join(dir, 'pairing.json'), 'utf8')).code, code);
    assert.notEqual(pairingCode(dir, true), code);
  });
});
