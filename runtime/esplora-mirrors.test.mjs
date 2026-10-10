// node --test runtime/esplora-mirrors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMirrors } from './esplora-mirrors.mjs';

const A = 'https://a.example/api', B = 'https://b.example/api', C = 'https://c.example/api';
const res = (status, body = 'x', headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, text: async () => body });
function world(handlers, extra = {}) {
  let t = 1_000_000; const calls = [];
  const m = makeMirrors({
    urls: [A, B, C], gapMs: 0, now: () => t, sleep: async (ms) => { t += ms; },
    fetchImpl: async (url) => { const host = new URL(url).origin; calls.push(host); const h = handlers[host]; if (!h) throw new Error('fetch failed'); return h(url, t); },
    ...extra,
  });
  return { m, calls, clock: () => t, advance: (ms) => { t += ms; } };
}

test('requests are rotated across the hosts', async () => {
  const w = world({ 'https://a.example': () => res(200), 'https://b.example': () => res(200), 'https://c.example': () => res(200) });
  for (let i = 0; i < 6; i++) await w.m.fetchBitcoin(`${A}/block-height/${i}`);
  assert.deepEqual([...new Set(w.calls)].sort(), ['https://a.example', 'https://b.example', 'https://c.example']);
  assert.ok(w.calls.filter((c) => c === 'https://a.example').length === 2, 'each takes its share');
});

test('a host that answers 429 is not asked again until its cooldown is over, and Retry-After is honoured', async () => {
  let a = 0;
  const w = world({ 'https://a.example': () => { a++; return res(429, '', { 'retry-after': '90' }); }, 'https://b.example': () => res(200), 'https://c.example': () => res(200) });
  for (let i = 0; i < 12; i++) assert.equal((await w.m.fetchBitcoin(`${A}/tip`)).status, 200);
  assert.equal(a, 1, 'asked once, then left alone');
  w.advance(91_000);
  for (let i = 0; i < 6; i++) await w.m.fetchBitcoin(`${A}/tip`);
  assert.ok(a >= 2, 'asked again after 90 s');
});

test('a host that keeps failing is cooled for longer each time', async () => {
  const w = world({ 'https://a.example': () => res(503), 'https://b.example': () => res(200), 'https://c.example': () => res(200) });
  const cools = [];
  for (let round = 0; round < 4; round++) {
    await w.m.fetchBitcoin(`${A}/x`); await w.m.fetchBitcoin(`${A}/x`); await w.m.fetchBitcoin(`${A}/x`);
    cools.push(w.m.status().find((s) => s.host === 'a.example').coolingMs);
    w.advance(cools[cools.length - 1] + 1);
  }
  assert.ok(cools[1] > cools[0] && cools[2] > cools[1], `cooldowns grow: ${cools}`);
});

test('when every host is cooling the call waits for the soonest, and gives up only past its limit', async () => {
  const w = world({ 'https://a.example': () => res(429, '', { 'retry-after': '5' }), 'https://b.example': () => res(429, '', { 'retry-after': '5' }), 'https://c.example': () => res(429, '', { 'retry-after': '5' }) }, { maxWaitMs: 15000 });
  await assert.rejects(w.m.fetchBitcoin(`${A}/y`), /no Bitcoin source answered/);
  // Retry-After of 5 s is within the limit: after the wait a host that has recovered answers.
  let up = false;
  const w2 = world({ 'https://a.example': () => (up ? res(200) : res(429, '', { 'retry-after': '5' })), 'https://b.example': () => (up ? res(200) : res(429, '', { 'retry-after': '5' })), 'https://c.example': () => (up ? res(200) : res(429, '', { 'retry-after': '5' })) });
  const p = w2.m.fetchBitcoin(`${A}/z`); up = true;
  assert.equal((await p).status, 200, 'it waited out the 5 s and then got an answer');
  const w3 = world({ 'https://a.example': () => res(429, '', { 'retry-after': '120' }), 'https://b.example': () => res(429, '', { 'retry-after': '120' }), 'https://c.example': () => res(429, '', { 'retry-after': '120' }) });
  const t0 = w3.clock();
  await assert.rejects(w3.m.fetchBitcoin(`${A}/q`), /cooling/);
  assert.ok(w3.clock() - t0 <= 15000, 'it never waits past the limit for a long cooldown');
});

test('a network failure is a refusal too, and the failing host is named', async () => {
  const w = world({ 'https://b.example': () => res(200), 'https://c.example': () => res(200) });   // a.example has no handler: fetch failed
  for (let i = 0; i < 4; i++) assert.equal((await w.m.fetchBitcoin(`${A}/n`)).status, 200);
  assert.match(w.m.describe(), /a\.example: cooling \d+s \(fetch failed \(a\.example\)\)/);
});

test('askOne asks the one host, and says nothing while it cools', async () => {
  const w = world({ 'https://a.example': () => res(429), 'https://b.example': () => res(200), 'https://c.example': () => res(200) });
  assert.equal(await w.m.askOne(A, '/h'), null);
  const before = w.calls.length;
  assert.equal(await w.m.askOne(A, '/h'), null);
  assert.equal(w.calls.length, before, 'no second request while cooling');
  assert.equal((await w.m.askOne(B, '/h')).status, 200);
});

test('requests to the same host are spaced by the gap', async () => {
  const stamps = []; let t = 0;
  const m = makeMirrors({ urls: [A], gapMs: 100, now: () => t, sleep: async (ms) => { t += ms; }, fetchImpl: async () => { stamps.push(t); return res(200); } });
  for (let i = 0; i < 4; i++) await m.fetchBitcoin(`${A}/s`);
  assert.deepEqual(stamps.map((s, i) => (i ? s - stamps[i - 1] : 100)), [100, 100, 100, 100]);
});

test('an attempt that hangs is cut off by its own timeout, and the host is cooled', async () => {
  let a = 0;
  const m = makeMirrors({ urls: [A, B], gapMs: 0, attemptTimeoutMs: 50,
    fetchImpl: async (url, init) => {
      if (url.startsWith(A)) { a++; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })))); }
      return res(200);
    } });
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) assert.equal((await m.fetchBitcoin(`${A}/h`)).status, 200);
  assert.equal(a, 1, 'the hanging host was tried once, then left alone');
  assert.ok(Date.now() - t0 < 1500, 'and the four requests did not wait out a connect timeout');
  assert.match(m.describe(), /a\.example: cooling \d+s \(The operation was aborted/);
});
