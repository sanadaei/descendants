import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testFile = fileURLToPath(new URL('../tests/worldgen-integration.test.mjs', import.meta.url));
const names = [
  'real Worldgen + game loop remains finite, persistent, and deterministic across one simulated year',
  'real Worldgen + game loop is deterministic across segmented time advancement',
  'coarse provider save reload re-materializes identical LOD people with provenance intact',
  'provider snapshot in a sandbox save resumes the same world without history regeneration',
  'real Worldgen accepts anomaly-utilization interventions only from an in-world epistemic basis and preserves them in causal history',
  'expedition observation and external command work against real generated entities',
  'production RealWorldProvider adapter loads the completed runtime and setting pack without gameplay branching',
  'real Worldgen boots sandbox population from provider-materialized origin individuals after burn-in',
];
const escapeRegex = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const batches = names.map((name) => [name]);
let passed = 0;
for (let i = 0; i < batches.length; i += 1) {
  const batch = batches[i];
  const pattern = `^(?:${batch.map(escapeRegex).join('|')})$`;
  console.log(`Real Worldgen integration batch ${i + 1}/${batches.length}: ${batch.length} tests`);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`, testFile], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  passed += batch.length;
}
console.log(`Real Worldgen integration: ${passed}/${names.length} PASS`);
