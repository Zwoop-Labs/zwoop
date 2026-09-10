import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const BASE = 'http://localhost:8080';
writeFileSync('/tmp/zwoop-test.txt', 'Hello from zwoop E2E test! ' + Date.now());

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

// Opens receiver, waits for code, opens sender, waits for pairing.
// Returns { receiver, sender, ctx } — caller is responsible for ctx.close().
async function setupPair() {
  const ctx = await browser.newContext();
  const receiver = await ctx.newPage();
  receiver.on('pageerror', e => console.error('[receiver]', e.message));

  await receiver.goto(BASE);
  await receiver.waitForSelector('.code-digits', { timeout: 10000 });
  const code = (await receiver.textContent('.code-digits')).trim();

  await receiver.waitForSelector('.status:has-text("Scan")', { timeout: 10000 });

  const sender = await ctx.newPage();
  sender.on('pageerror', e => console.error('[sender]', e.message));
  await sender.goto(`${BASE}/join/${code}`);
  await sender.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  await receiver.waitForSelector('.status:has-text("waiting for file")', { timeout: 10000 });

  return { receiver, sender, ctx };
}

// ── Test 1: basic transfer ────────────────────────────────────────────────────

await run('basic file transfer', async () => {
  const { receiver, sender, ctx } = await setupPair();
  try {
    await sender.locator('#file-input').setInputFiles('/tmp/zwoop-test.txt', { force: true });
    await sender.waitForSelector('.status.success', { timeout: 30000 });
    await receiver.waitForSelector('.status.success', { timeout: 30000 });

    const senderMsg = (await sender.textContent('.status.success')).trim();
    const receiverMsg = (await receiver.textContent('.status.success')).trim();

    if (!senderMsg.includes('sent successfully')) throw new Error(`Unexpected sender message: ${senderMsg}`);
    if (!receiverMsg.includes('received')) throw new Error(`Unexpected receiver message: ${receiverMsg}`);
  } finally {
    await ctx.close();
  }
});

// ── Test 2: receiver disconnects after send → sender shows error ──────────────

await run('receiver disconnect detected after send', async () => {
  const { receiver, sender, ctx } = await setupPair();
  try {
    // Complete one transfer first.
    await sender.locator('#file-input').setInputFiles('/tmp/zwoop-test.txt', { force: true });
    await sender.waitForSelector('.status.success', { timeout: 30000 });

    // Close the receiver tab — this closes its WebSocket, triggering peer-left on sender.
    await receiver.close();

    // Sender should transition to error.
    await sender.waitForSelector('.status.error', { timeout: 5000 });
    const errMsg = (await sender.textContent('.status.error')).trim();
    if (!errMsg.includes('Receiver disconnected')) throw new Error(`Expected disconnect error, got: ${errMsg}`);
  } finally {
    await ctx.close();
  }
});

// ── Test 3: a relay tampering with the SPAKE2 handshake is detected ───────────
// Simulates a malicious/compromised signaling relay corrupting a pairing
// message in transit (functionally identical, from the receiver's
// perspective, to the sender itself sending a corrupted message — the
// defense can't and shouldn't distinguish the two).

await run('tampered SPAKE2 message blocks pairing on both sides', async () => {
  const ctx = await browser.newContext();
  const receiver = await ctx.newPage();
  receiver.on('pageerror', e => console.error('[receiver]', e.message));
  await receiver.goto(BASE);
  await receiver.waitForSelector('.code-digits', { timeout: 10000 });
  const code = (await receiver.textContent('.code-digits')).trim();
  await receiver.waitForSelector('.status:has-text("Scan")', { timeout: 10000 });

  const sender = await ctx.newPage();
  sender.on('pageerror', e => console.error('[sender]', e.message));

  // Flip a hex nibble in every outgoing spake-msg frame before it leaves the
  // browser, as an on-the-wire tamperer would.
  await sender.addInitScript(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'spake-msg' && typeof msg.payload === 'string') {
          msg.payload = (msg.payload[0] === '0' ? '1' : '0') + msg.payload.slice(1);
          data = JSON.stringify(msg);
        }
      } catch {
        // not JSON, or not ours to touch — pass through untouched
      }
      return originalSend.call(this, data);
    };
  });

  try {
    await sender.goto(`${BASE}/join/${code}`);

    await receiver.waitForSelector('.status.error', { timeout: 10000 });
    await sender.waitForSelector('.status.error', { timeout: 10000 });

    const receiverErr = (await receiver.textContent('.status.error')).trim();
    if (!receiverErr.includes('Security check failed')) {
      throw new Error(`Expected security error on receiver, got: ${receiverErr}`);
    }

    const senderErr = (await sender.textContent('.status.error')).trim();
    if (senderErr.length === 0) throw new Error('Sender showed no error at all');

    if ((await sender.locator('#file-input').count()) > 0) {
      throw new Error('File input appeared on sender despite failed pairing');
    }
  } finally {
    await ctx.close();
  }
});

// ── Test 4: a relay tampering with the SDP fingerprint MAC is detected ────────
// This is the primary threat the pairing/channel-binding design defends
// against: pairing itself succeeds (the relay doesn't touch the SPAKE2
// stage), but the relay swaps bytes in the offer's fingerprint MAC —
// modeling an attempt to substitute its own DTLS certificate later in the
// handshake. It must be caught here, independently of SPAKE2 confirmation.

await run('tampered SDP fingerprint MAC blocks the transfer after pairing succeeds', async () => {
  const ctx = await browser.newContext();
  const receiver = await ctx.newPage();
  receiver.on('pageerror', e => console.error('[receiver]', e.message));
  await receiver.goto(BASE);
  await receiver.waitForSelector('.code-digits', { timeout: 10000 });
  const code = (await receiver.textContent('.code-digits')).trim();
  await receiver.waitForSelector('.status:has-text("Scan")', { timeout: 10000 });

  const sender = await ctx.newPage();
  sender.on('pageerror', e => console.error('[sender]', e.message));

  // Flip a hex nibble in the offer's fingerprint MAC before it leaves the
  // browser. SPAKE2 pairing itself is untouched, so it succeeds normally.
  await sender.addInitScript(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'offer' && msg.payload && typeof msg.payload.mac === 'string') {
          const mac = msg.payload.mac;
          msg.payload.mac = (mac[0] === '0' ? '1' : '0') + mac.slice(1);
          data = JSON.stringify(msg);
        }
      } catch {
        // not JSON, or not ours to touch — pass through untouched
      }
      return originalSend.call(this, data);
    };
  });

  try {
    await sender.goto(`${BASE}/join/${code}`);
    await sender.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
    await receiver.waitForSelector('.status:has-text("waiting for file")', { timeout: 10000 });

    await sender.locator('#file-input').setInputFiles('/tmp/zwoop-test.txt', { force: true });

    await receiver.waitForSelector('.status.error', { timeout: 10000 });
    const receiverErr = (await receiver.textContent('.status.error')).trim();
    if (!receiverErr.includes('Security check failed')) {
      throw new Error(`Expected security error on receiver, got: ${receiverErr}`);
    }

    await sender.waitForSelector('.status.error', { timeout: 10000 });
    const senderErr = (await sender.textContent('.status.error')).trim();
    if (senderErr.length === 0) throw new Error('Sender showed no error at all');

    if ((await receiver.locator('.status.success').count()) > 0) {
      throw new Error('Receiver reported a successful transfer despite the tampered fingerprint');
    }
  } finally {
    await ctx.close();
  }
});

// ── Test 5: a relay tampering with the answer's fingerprint MAC (the other
// direction) is detected ───────────────────────────────────────────────────
// Mirrors Test 4 but tampers the receiver→sender leg (the answer) instead of
// the sender→receiver leg (the offer). This exercises createSenderChannel's
// verification path in webrtc.ts, which is separate code from the offer path
// exercised above — the two directions aren't guaranteed to fail the same
// way just because the underlying crypto is symmetric.

await run('tampered SDP fingerprint MAC on the answer blocks the transfer', async () => {
  const ctx = await browser.newContext();
  const receiver = await ctx.newPage();
  receiver.on('pageerror', e => console.error('[receiver]', e.message));

  // Flip a hex nibble in the answer's fingerprint MAC before it leaves the
  // browser. SPAKE2 pairing and the offer are untouched, so both succeed
  // normally — only the answer, sent after the receiver has already
  // verified the offer, is corrupted.
  await receiver.addInitScript(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'answer' && msg.payload && typeof msg.payload.mac === 'string') {
          const mac = msg.payload.mac;
          msg.payload.mac = (mac[0] === '0' ? '1' : '0') + mac.slice(1);
          data = JSON.stringify(msg);
        }
      } catch {
        // not JSON, or not ours to touch — pass through untouched
      }
      return originalSend.call(this, data);
    };
  });

  await receiver.goto(BASE);
  await receiver.waitForSelector('.code-digits', { timeout: 10000 });
  const code = (await receiver.textContent('.code-digits')).trim();
  await receiver.waitForSelector('.status:has-text("Scan")', { timeout: 10000 });

  const sender = await ctx.newPage();
  sender.on('pageerror', e => console.error('[sender]', e.message));

  try {
    await sender.goto(`${BASE}/join/${code}`);
    await sender.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
    await receiver.waitForSelector('.status:has-text("waiting for file")', { timeout: 10000 });

    await sender.locator('#file-input').setInputFiles('/tmp/zwoop-test.txt', { force: true });

    await sender.waitForSelector('.status.error', { timeout: 10000 });
    const senderErr = (await sender.textContent('.status.error')).trim();
    if (!senderErr.includes('Security check failed')) {
      throw new Error(`Expected security error on sender, got: ${senderErr}`);
    }

    await receiver.waitForSelector('.status.error', { timeout: 10000 });
    const receiverErr = (await receiver.textContent('.status.error')).trim();
    if (receiverErr.length === 0) throw new Error('Receiver showed no error at all');

    if ((await sender.locator('.status.success').count()) > 0) {
      throw new Error('Sender reported a successful transfer despite the tampered fingerprint');
    }
  } finally {
    await ctx.close();
  }
});

// ── Test 6: a relay tampering with an ICE candidate's MAC is detected ─────────
// Mirrors Test 4/5 but for the per-candidate MAC instead of the SDP fingerprint MAC.

await run('tampered ICE candidate MAC blocks the transfer', async () => {
  const ctx = await browser.newContext();
  const receiver = await ctx.newPage();
  receiver.on('pageerror', e => console.error('[receiver]', e.message));
  await receiver.goto(BASE);
  await receiver.waitForSelector('.code-digits', { timeout: 10000 });
  const code = (await receiver.textContent('.code-digits')).trim();
  await receiver.waitForSelector('.status:has-text("Scan")', { timeout: 10000 });

  const sender = await ctx.newPage();
  sender.on('pageerror', e => console.error('[sender]', e.message));

  // Flip a hex nibble in every outgoing candidate frame's MAC before it
  // leaves the browser, as an on-the-wire tamperer would.
  await sender.addInitScript(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'candidate' && msg.payload && typeof msg.payload.mac === 'string') {
          const mac = msg.payload.mac;
          msg.payload.mac = (mac[0] === '0' ? '1' : '0') + mac.slice(1);
          data = JSON.stringify(msg);
        }
      } catch {
        // not JSON, or not ours to touch — pass through untouched
      }
      return originalSend.call(this, data);
    };
  });

  try {
    await sender.goto(`${BASE}/join/${code}`);
    await sender.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
    await receiver.waitForSelector('.status:has-text("waiting for file")', { timeout: 10000 });

    await sender.locator('#file-input').setInputFiles('/tmp/zwoop-test.txt', { force: true });

    await receiver.waitForSelector('.status.error', { timeout: 10000 });
    const receiverErr = (await receiver.textContent('.status.error')).trim();
    if (!receiverErr.includes('Security check failed')) {
      throw new Error(`Expected security error on receiver, got: ${receiverErr}`);
    }

    if ((await receiver.locator('.status.success').count()) > 0) {
      throw new Error('Receiver reported a successful transfer despite the tampered candidate MAC');
    }
  } finally {
    await ctx.close();
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

await browser.close();
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
