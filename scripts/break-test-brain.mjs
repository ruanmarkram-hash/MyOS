#!/usr/bin/env node
// Break test: forces OB1 to fail (bad URL). Confirms buildMemoryContextOb1
// throws, and the memory.ts fallback to SQLite kicks in cleanly.
//
// We don't exercise the full buildMemoryContext() here (it also touches
// team-activity and history-recall SQLite paths that need the bot's DB
// to be initialised). Instead we verify the two behaviours in isolation:
//   1. OB1 adapter throws when endpoint is unreachable.
//   2. memory.ts try/catch around the OB1 call swallows the error and
//      returns the SQLite-assembled block (simulated).

import { readFileSync } from 'node:fs';

const envText = readFileSync('/Users/sagecos1/HQ/.env', 'utf-8');
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

// Force a bad URL by pointing at a non-existent host
process.env.BRAIN = 'ob1';
process.env.OB1_SUPABASE_URL = 'https://zzz-does-not-exist-9876543210.supabase.co';
process.env.MCP_ACCESS_KEY = env.MCP_ACCESS_KEY;
process.env.GOOGLE_API_KEY = env.GOOGLE_API_KEY;
// Load fresh modules — config reads env at import time
const { ob1Available, buildMemoryContextOb1 } = await import(`/Users/sagecos1/HQ/dist/brain/adapter.js?t=${Date.now()}`);

console.log('Step 1: ob1Available() with bad URL still returns true (URL is present even if dead):', ob1Available());

console.log('\nStep 2: buildMemoryContextOb1() should throw when endpoint unreachable...');
let threw = false;
let msg = '';
try {
  await buildMemoryContextOb1('anything');
} catch (err) {
  threw = true;
  msg = err.message;
}
if (!threw) {
  console.error('FAIL: expected an error but got success');
  process.exit(1);
}
console.log(`  threw as expected: ${msg.slice(0, 120)}...`);

console.log('\nStep 3: simulating the memory.ts fallback pattern (try/catch around OB1 call)...');
let fallbackUsed = false;
let ob1Block = '';
try {
  ob1Block = await buildMemoryContextOb1('anything');
} catch {
  fallbackUsed = true;
  // in real code this is where Layer 1 SQLite runs — here we just simulate
  ob1Block = '';
}
console.log(`  fallbackUsed: ${fallbackUsed}, ob1Block: "${ob1Block}"`);
if (!fallbackUsed) {
  console.error('FAIL: fallback did not trigger');
  process.exit(1);
}

console.log('\nbreak test: PASS (bad URL throws, fallback pattern catches cleanly)');
