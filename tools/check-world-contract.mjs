import { FROZEN_WORLD_CONTRACT_SHA256 } from './world-contract-integrity.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const text = await readFile(new URL('../src/worldbridge/contract.ts', import.meta.url), 'utf8');
const got = createHash('sha256').update(text).digest('hex');
const expected = FROZEN_WORLD_CONTRACT_SHA256;
if (got !== expected) { console.error(`World contract drift: ${got} !== ${expected}`); process.exit(1); }
console.log(`world-contract ${got}`);
