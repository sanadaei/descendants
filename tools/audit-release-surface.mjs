import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDurablePackagePath, isTransientPackageDirectory, portableRelative } from './package-integrity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = path.join(root, 'src');
const distRoot = path.join(root, 'dist');

async function walk(dir, predicate = () => true) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, predicate));
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function rel(base, file) { return path.relative(base, file).split(path.sep).join('/'); }
function importSpecs(source) {
  const out = [];
  const pattern = /(?:from\s+|import\s*\()(['"])([^'"]+)\1/g;
  for (const match of source.matchAll(pattern)) if (match[2].startsWith('.')) out.push(match[2]);
  return out;
}
function resolveTs(fromFile, spec, all) {
  const raw = path.resolve(path.dirname(fromFile), spec);
  const candidates = spec.endsWith('.js') ? [raw.slice(0, -3) + '.ts'] : [raw + '.ts', path.join(raw, 'index.ts')];
  return candidates.find((candidate) => all.has(candidate));
}

const tsFiles = await walk(srcRoot, (file) => file.endsWith('.ts'));
const allTs = new Set(tsFiles.map((file) => path.resolve(file)));
const reachable = new Set();
const queue = [path.resolve(srcRoot, 'main.ts')];
while (queue.length) {
  const file = queue.pop();
  if (!file || reachable.has(file)) continue;
  reachable.add(file);
  const source = await readFile(file, 'utf8');
  for (const spec of importSpecs(source)) {
    const resolved = resolveTs(file, spec, allTs);
    if (resolved && !reachable.has(resolved)) queue.push(resolved);
  }
}
const testOnlyExpected = new Set([
  'sandbox/anomalyIntegration.ts',
  'sandbox/endings.ts',
]);
const unreachable = tsFiles.map((file) => rel(srcRoot, file)).filter((file) => !reachable.has(path.resolve(srcRoot, file))).sort();
assert.deepEqual(unreachable, [...testOnlyExpected].sort(), `unexpected release-unreachable TypeScript: ${unreachable.join(', ')}`);
const testsText = (await Promise.all((await walk(path.join(root, 'tests'), (file) => file.endsWith('.mjs'))).map((file) => readFile(file, 'utf8')))).join('\n');
for (const module of testOnlyExpected) assert.match(testsText, new RegExp(module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\.ts$/, '\\.(?:js|ts)')), `test-only module is not covered: ${module}`);

const app = await readFile(path.join(srcRoot, 'sandbox', 'app.ts'), 'utf8');
const renderedActions = new Set([...app.matchAll(/data-action=["']([^"']+)/g)].map((match) => match[1]));
const clickActions = new Set([...app.matchAll(/action===["']([^"']+)["']/g)].map((match) => match[1]));
const changeActions = new Set([...app.matchAll(/\[data-action=["']([^"']+)["']\]/g)].map((match) => match[1]));
const routed = new Set([...clickActions, ...changeActions]);
const unrouted = [...renderedActions].filter((action) => !routed.has(action)).sort();
assert.deepEqual(unrouted, [], `unrouted UI actions: ${unrouted.join(', ')}`);
for (const action of ['policy','external','anomaly-use','launch','direct-camp','wedo-round','conversation','archive-knowledge','research','export','export-recovery-report','export-quarantine','import']) assert.ok(renderedActions.has(action), `release-critical UI action not rendered: ${action}`);
assert.doesNotMatch(app, /private (?:settlementView|peopleView|medicineView|knowledgeView|worldView)\(/, 'dead pre-F1/F5 subview remains in release UI source');
assert.doesNotMatch(app, /\.lossState\b/, 'release UI directly references hidden expedition lossState');
assert.doesNotMatch(app, /discoveredVariableIds|Developer provider diagnostics|devDiagnostics/, 'release UI exposes provider recipe diagnostics');
assert.match(app, /isBusySafeUiAction/);
assert.match(app, /acting local command perspective/);
assert.match(app, /role="tablist"/);
assert.match(app, /restoreFocus/);
assert.match(app, /private async resetSave\(\)/);
assert.match(app, /private async importSave\(file: File\)/);
assert.doesNotMatch(app, /person:0[0-9]|\bMira\b|\bKai\b/, 'fixed synthetic population marker remains in release UI');

const allReleaseSource = (await Promise.all([...reachable].map((file) => readFile(file, 'utf8')))).join('\n');
assert.doesNotMatch(allReleaseSource, /\?legacy=1|\?lineage=1|debugScene|new GameApp\b/, 'legacy startup/runtime marker remains in production import graph');
const providerJournalSource = await readFile(path.join(srcRoot, 'sandbox', 'providerMutationJournal.ts'), 'utf8');
const expeditionSource = await readFile(path.join(srcRoot, 'sandbox', 'expeditionSimulation.ts'), 'utf8');
const storageSource = await readFile(path.join(srcRoot, 'sandbox', 'storage.ts'), 'utf8');
const providerIssueOccurrences = [];
for (const file of reachable) {
  const source = await readFile(file, 'utf8');
  if (/\.issueCommand\(/.test(source)) providerIssueOccurrences.push(rel(srcRoot, file));
}
assert.deepEqual(providerIssueOccurrences.sort(), ['sandbox/providerMutationJournal.ts'], 'provider commands bypass the persistent idempotency journal');
assert.match(providerJournalSource, /MAX_DETAILED_ORDINAL_RECEIPTS\s*=\s*256/);
assert.match(providerJournalSource, /retiredThroughOrdinal/);
assert.match(providerJournalSource, /replay was suppressed/i);
assert.match(expeditionSource, /providerCommandId.*nextProviderCommandId/s);
assert.doesNotMatch(expeditionSource, /id:\s*`game:\$\{order\.id\}`/, 'expedition contact still uses non-ordinal legacy provider command ids');
assert.match(storageSource, /assertPreviousGenerationParent/);
assert.match(storageSource, /parentStateHash/);
assert.match(storageSource, /MAX_QUARANTINE_HISTORY\s*=\s*24/);
assert.match(storageSource, /MAX_FULL_QUARANTINES\s*=\s*4/);
assert.match(storageSource, /metadata-only/);
assert.match(storageSource, /buildSaveLineageForensicReport/);
assert.match(app, /export-recovery-report/);
assert.match(app, /export-quarantine/);

const forbiddenPaths = [
  'public/studio.html','public/studio.js','public/studio.css','public/studio','release/authoring-studio',
  'src/studio-runtime.ts','src/content','src/core','src/ui','src/persistence','src/lineage','content','public/content','public/golden','resources',
];
for (const forbidden of forbiddenPaths) await assert.rejects(access(path.join(root, forbidden)), undefined, `forbidden legacy path exists: ${forbidden}`);

await access(distRoot);
const distFiles = await walk(distRoot);
const distRel = distFiles.map((file) => rel(distRoot, file));
for (const required of ['index.html','assets/main.js','assets/sandbox/app.js','assets/worldbridge/realWorldProvider.js','worldgen/runtime-manifest.json','build-meta.json']) assert.ok(distRel.includes(required), `release dist missing: ${required}`);
for (const file of distRel) {
  assert.doesNotMatch(file, /(^|\/)studio(?:\.|\/)|game-content|golden/i, `legacy path in release dist: ${file}`);
  if (file.startsWith('assets/')) assert.doesNotMatch(file, /^assets\/(?:content|core|ui|lineage)(?:\.|\/)/i, `legacy app module in release dist: ${file}`);
}
const distJs = distFiles.filter((file) => file.endsWith('.js'));
for (const file of distJs) {
  const source = await readFile(file, 'utf8');
  assert.doesNotMatch(source, /studio\.html|\?legacy=1|\?lineage=1|debugScene|new GameApp\b/, `legacy runtime marker in ${rel(distRoot, file)}`);
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const meta = JSON.parse(await readFile(path.join(distRoot, 'build-meta.json'), 'utf8'));
const runtime = JSON.parse(await readFile(path.join(distRoot, 'worldgen', 'runtime-manifest.json'), 'utf8'));
assert.equal(meta.product, 'descendants-generated-world');
assert.equal(meta.version, pkg.version);
assert.equal(meta.reproducible, true, 'portable build metadata must declare reproducible output');
assert.equal(Object.hasOwn(meta, 'builtAt'), false, 'portable build metadata must not embed wall-clock time');
assert.equal(meta.worldgen.runtimeSha256, runtime.runtimeSha256);
assert.equal(meta.worldgen.engineVersion, runtime.engineVersion);
assert.equal(runtime.recipeId, 'descendants-sandbox-default');
assert.match(runtime.runtimeSha256, /^[0-9a-f]{64}$/);

const packageRoot = path.resolve(root, '..');
const packageManifestPath = path.join(packageRoot, 'PACKAGE_CONTENT_SHA256.txt');
const packageManifestText = await readFile(packageManifestPath, 'utf8');
const packageManifest = new Map();
for (const line of packageManifestText.split(/\r?\n/).filter(Boolean)) {
  const match = line.match(/^([0-9a-f]{64})  \.\/(.+)$/);
  assert.ok(match, `malformed package SHA line: ${line}`);
  assert.equal(packageManifest.has(match[2]), false, `duplicate package SHA entry: ${match[2]}`);
  packageManifest.set(match[2], match[1]);
}
async function walkDurablePackage(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = portableRelative(packageRoot, full);
    if (entry.isDirectory()) {
      if (!isTransientPackageDirectory(relative)) out.push(...await walkDurablePackage(full));
    } else if (isDurablePackagePath(relative)) out.push(full);
  }
  return out;
}
const packageFiles = await walkDurablePackage(packageRoot);
const packageRel = packageFiles.map((file) => portableRelative(packageRoot, file)).sort();
assert.equal([...packageManifest.keys()].some((file) => !isDurablePackagePath(file)), false, 'package SHA manifest contains transient local/test artifacts');
assert.deepEqual([...packageManifest.keys()].sort(), packageRel, 'package SHA manifest does not exactly cover the release artifact tree');
for (const file of packageFiles) {
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(packageManifest.get(portableRelative(packageRoot, file)), digest, `package SHA mismatch: ${portableRelative(packageRoot, file)}`);
}

const releaseManifestPath = path.resolve(root, '..', 'V1_RELEASE_MANIFEST.json');
try {
  const releaseManifest = JSON.parse(await readFile(releaseManifestPath, 'utf8'));
  assert.equal(releaseManifest.mainRegression?.passed, 198, 'release manifest has stale Main regression count');
  assert.equal(releaseManifest.mainRegression?.failed, 0);
  assert.equal(releaseManifest.releaseSurfaceAudit?.releaseReachableTypeScript, reachable.size, 'release manifest has stale reachable TypeScript count');
  assert.equal(releaseManifest.releaseSurfaceAudit?.intentionalTestOnlyTypeScript, testOnlyExpected.size);
  assert.equal(releaseManifest.releaseSurfaceAudit?.routedUiActions, renderedActions.size, 'release manifest has stale routed UI count');
  assert.equal(releaseManifest.releaseSurfaceAudit?.distFiles, distRel.length, 'release manifest has stale dist file count');
  assert.equal(releaseManifest.packageContentIntegrity?.files, packageManifest.size, 'release manifest has stale package SHA count');
  assert.equal(releaseManifest.accessibilityInteractionAudit?.primaryViewKeyboardTransitions, 250000);
  assert.equal(releaseManifest.destructivePersistenceAudit?.status, 'pass');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const currentEvidenceFiles = ['CONTINUE_HERE.md','FINAL_VERIFICATION.txt','FINAL_INTEGRATION_REPORT.md','FINAL_V1_RELEASE_REPORT.md','Descendants/CHANGELOG.md','Descendants/docs/IMPLEMENTATION_REPORT_1.0.0.md'];
const currentEvidence = (await Promise.all(currentEvidenceFiles.map((name)=>readFile(path.resolve(root,'..',name), 'utf8')))).join('\n');
assert.doesNotMatch(currentEvidence, /\b141\s*\/\s*141\b|\b131\s*\/\s*131\b|\b123\s*\/\s*123\b|\b98\s*\/\s*98\b|\b94\s*\/\s*94\b|\b85\s*\/\s*85\b|\b81\s*\/\s*81\b|\b79\s*\/\s*79\b|\b77\s*\/\s*77\b|\b73\s*\/\s*73\b|\b44\s*\/\s*44\b|\b31\s*\/\s*33\b|\b30\s*\/\s*32\b|\b29\s*\/\s*32\b|\b28\s*\/\s*31\b|\b113 files\b|\b111 files\b|\b109 files\b|\b107 files\b|\b506\s*\/\s*506\b|\b502\s*\/\s*502\b|\b500\s*\/\s*500\b|\b496\s*\/\s*496\b/, 'stale pre-hardening release evidence remains in current metadata');

console.log(`Release surface audit: PASS (${reachable.size}/${tsFiles.length} release-reachable TS; ${testOnlyExpected.size} intentional test-only; ${renderedActions.size} routed UI actions; ${distRel.length} dist files).`);
