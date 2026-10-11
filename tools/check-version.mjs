import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFile(resolve(root, name), 'utf8');
const version = (await read('VERSION')).trim();
const contract = JSON.parse(await read('VERSION_CONTRACT.json'));
const pkg = JSON.parse(await read('package.json'));
const indexHtml = await read('index.html');
const changelog = await read('CHANGELOG.md');
const architecture = await read('docs/ARCHITECTURE.md');
const worldgenManifest = JSON.parse(await read('public/worldgen/runtime-manifest.json'));
const worldContract = await read('src/worldbridge/contract.ts');
const errors = [];

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) errors.push(`VERSION の形式が不正です: ${version}`);
if (pkg.version !== version) errors.push(`package.json=${pkg.version}, VERSION=${version}`);
if (contract.appVersion !== version) errors.push(`VERSION_CONTRACT.appVersion=${contract.appVersion}, VERSION=${version}`);
if (!indexHtml.includes(`— ${version}</title>`)) errors.push('index.htmlの表示versionが一致しません。');
if (!changelog.includes(`## [${version}]`)) errors.push(`CHANGELOG.md に [${version}] がありません。`);
if (!architecture.includes(`アプリケーションは \`${version}\``)) errors.push('ARCHITECTURE.mdのアプリケーション版が一致しません。');
if (!worldContract.includes('FROZEN SHARED CONTRACT v1.0.0')) errors.push('WorldProvider frozen contract declarationが見つかりません。');
if (worldgenManifest.engineVersion !== '1.5.0') errors.push(`packaged Worldgen engine=${worldgenManifest.engineVersion}, expected=1.5.0`);
if (worldgenManifest.recipeId !== 'descendants-sandbox-default') errors.push(`unexpected Worldgen recipe=${worldgenManifest.recipeId}`);
if (!/^[0-9a-f]{64}$/.test(String(worldgenManifest.runtimeSha256 ?? ''))) errors.push('Worldgen runtime manifest SHA-256 is invalid.');

if (errors.length) {
  for (const error of errors) console.error(`VERSION ERROR: ${error}`);
  process.exit(1);
}
console.log(`Version contract OK: app ${version} / sandbox save 1 / WorldProvider 1.0.0 / Worldgen ${worldgenManifest.engineVersion}`);
