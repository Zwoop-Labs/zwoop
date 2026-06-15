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

// ── Summary ───────────────────────────────────────────────────────────────────

await browser.close();
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
