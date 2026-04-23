#!/usr/bin/env node
// Smoke test for OB1 brain: ping, capture, search round-trip.
// Run: node scripts/smoke-brain.mjs
// Exit code 0 = healthy, non-zero = failure.

process.env.BRAIN = 'ob1';

const { pingBrain, captureThought, searchThoughts, brainEnabled } =
  await import('/Users/sagecos1/HQ/dist/brain/client.js');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!brainEnabled()) fail('brainEnabled() returned false; check BRAIN / OB1_SUPABASE_URL / MCP_ACCESS_KEY in .env');

const ok = await pingBrain();
if (!ok) fail('pingBrain() returned false; MCP endpoint unreachable or auth rejected');
console.log('1/3 ping OK');

const unique = `smoke-${Date.now()}`;
const sentinel = `Smoke test sentinel ${unique}: brain round-trip verification.`;
const cap = await captureThought({ content: sentinel });
if (!cap.ok) fail(`capture returned not-ok: ${JSON.stringify(cap)}`);
console.log(`2/3 capture OK: ${cap.confirmation}`);

// Give the HNSW index a moment; usually not needed but belt-and-braces
await new Promise((r) => setTimeout(r, 500));

const start = Date.now();
const result = await searchThoughts({ query: `smoke sentinel ${unique}`, limit: 3, threshold: 0.3 });
const ms = Date.now() - start;
if (!result.includes(unique)) fail(`search did not return the sentinel.\nGot:\n${result}`);
console.log(`3/3 search OK in ${ms}ms (sentinel matched)`);

console.log('\nbrain smoke: PASS');
