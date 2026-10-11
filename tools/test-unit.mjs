import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileTestDist } from './compile-test-dist.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const compileCode = await compileTestDist();
if (compileCode !== 0) process.exit(compileCode);
const testFiles = [
  fileURLToPath(new URL('../tests/exploration-continuity.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/evidence-connections.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/generations-naming.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/sandbox-game-loop.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/generated-ui-contract.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/v1-release.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/pda-presentation.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i1-knowledge-store.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i1-knowledge-shadow-adapter.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i1-f3-projection-compare.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i1-f3-read-switch.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i1-world-graph-projection-compare.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i1-world-graph-read-switch.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i1-knowledge-persistence.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i1-consolidation-gate.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i2-incident-adapter.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/i2l-debrief-read-model.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/survival-campaign.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/survival-campaign-lifecycle.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/survival-campaign-ui.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/survival-campaign-playability.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/survival-release.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/resource-ledger.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/resource-rationing.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/resource-field-harvest.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/resource-rationing-ui.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/daily-action-loop.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/daily-command-read-model.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../tests/daily-action-loop-ui.test.mjs', import.meta.url)),
];
const tests = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], { cwd: projectRoot, stdio: 'inherit', shell: false });
const testCode = await new Promise((resolve) => tests.on('close', resolve));
process.exit(Number(testCode ?? 1));
