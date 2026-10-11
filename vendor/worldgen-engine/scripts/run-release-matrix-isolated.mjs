import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const caseIds = ['long-runtime','large-stream','stream-churn','medium-a','medium-b','small-a','small-b'];
const requested = new Set((process.env.WORLDGEN_MATRIX_CASES ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const selected = requested.size ? caseIds.filter((id) => requested.has(id)) : caseIds;
// Constrained hosts become unstable after too many consecutive high-RSS child processes.
// Keep at most three child processes for the five heavy release cases while preserving
// process isolation between the largest stream cases. Lightweight-only selections remain direct.
let batches;
if (selected.length === 5 && ['long-runtime','large-stream','stream-churn','medium-a','medium-b'].every((id) => selected.includes(id))) {
  batches = [['long-runtime','medium-a'], ['large-stream','medium-b'], ['stream-churn']];
} else if (selected.length > 5) {
  batches = [['long-runtime','medium-a','small-a'], ['large-stream','medium-b','small-b'], ['stream-churn']].map((batch) => batch.filter((id) => selected.includes(id))).filter((batch) => batch.length);
} else {
  batches = selected.map((id) => [id]);
}
const output = resolve(process.argv[2] ?? '../integration-artifacts/worldgen/RELEASE_MATRIX_v6.json');
const dir = await mkdtemp(join(tmpdir(), 'worldgen-release-matrix-'));
const reports = []; const started = performance.now();
try {
  for (const batch of batches) {
    const label = batch.join('+'); const caseOutput = join(dir, `${label}.json`);
    const child = spawnSync(process.execPath, [new URL('./run-release-matrix.mjs', import.meta.url).pathname, caseOutput], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, WORLDGEN_MATRIX_CASES: batch.join(',') },
    });
    if (child.error) throw child.error;
    if ((child.status ?? 1) !== 0) throw new Error(`Release matrix batch ${label} failed with status ${child.status}: ${child.stderr ?? ''}`);
    const report = JSON.parse(await readFile(caseOutput, 'utf8'));
    reports.push(report);
    for (const result of report.results ?? []) console.log(`[matrix] ${result.id}: ${result.pass ? 'PASS' : 'FAIL'} ${Math.round(Number(result.totalMs ?? 0))} ms, entities=${result.entities ?? 0}, events=${result.events ?? 0}`);
  }
  const results = reports.flatMap((report) => report.results ?? []);
  const report = {
    generatedAt: new Date().toISOString(),
    engineVersion: reports[0]?.engineVersion ?? 'unknown',
    isolation: 'heavy cases isolated; lightweight tail batched when host child-process ceiling requires it',
    caseCount: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    wallMs: performance.now() - started,
    peakCaseRss: Math.max(0, ...results.map((result) => Number(result.rssAfter ?? 0))),
    results,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`[matrix] complete ${report.passed}/${report.caseCount} PASS, wall=${Math.round(report.wallMs)} ms, peakCaseRss=${report.peakCaseRss}`);
  if (report.failed) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
