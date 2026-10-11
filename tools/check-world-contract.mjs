import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const text = await readFile(new URL('../src/worldbridge/contract.ts', import.meta.url), 'utf8');
const got = createHash('sha256').update(text).digest('hex');
const expected = 'edcadd649b8f3b154af2edb9c50c4489a089c215f58697156c1d0890c961afca';
if (got !== expected) { console.error(`World contract drift: ${got} !== ${expected}`); process.exit(1); }
console.log(`world-contract ${got}`);
