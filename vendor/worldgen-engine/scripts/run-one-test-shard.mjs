import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const shardNumber = Number.parseInt(process.argv[2] ?? '1', 10);
const shardCount = Number.parseInt(process.argv[3] ?? '3', 10);
if (!(shardNumber >= 1 && shardNumber <= shardCount && shardCount >= 1)) {
  console.error('Usage: node scripts/run-one-test-shard.mjs <1-based-shard> <shard-count>');
  process.exit(2);
}

const file = new URL('../tests/worldgen.test.mjs', import.meta.url);
const source = readFileSync(file, 'utf8');
const names = [...source.matchAll(/^test\('([^']+)'/gm)].map((match) => match[1]);
const size = Math.ceil(names.length / shardCount);
const shardNames = names.slice((shardNumber - 1) * size, Math.min(names.length, shardNumber * size));
const escapeRegex = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Constrained hosts can cap repeated child-process creation, while the stress fixture has much higher
// peak RSS than ordinary tests. Run stress cases alone first, then batch ordinary tests in groups of at most 13.
const highCost = shardNames.filter((name) => name.includes('stress fixture generates'));
const ordinary = shardNames.filter((name) => !highCost.includes(name));
const batches = highCost.map((name) => [name]);
for (let i = 0; i < ordinary.length; i += 13) batches.push(ordinary.slice(i, i + 13));

console.log(`Worldgen test shard ${shardNumber}/${shardCount}: ${shardNames.length} tests in ${batches.length} host-safe batch(es)`);
let passed = 0;
for (let index = 0; index < batches.length; index += 1) {
  const batch = batches[index];
  const pattern = `^(?:${batch.map(escapeRegex).join('|')})$`;
  console.log(`[batch ${index + 1}/${batches.length}] ${batch.length} test(s)`);
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file.pathname], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  passed += batch.length;
}
console.log(`Shard ${shardNumber}/${shardCount}: ${passed}/${shardNames.length} PASS`);
