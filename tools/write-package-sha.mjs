import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDurablePackagePath, isTransientPackageDirectory, portableRelative } from './package-integrity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = path.resolve(root, '..');
const manifestPath = path.join(packageRoot, 'PACKAGE_CONTENT_SHA256.txt');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = portableRelative(packageRoot, full);
    if (entry.isDirectory()) {
      if (!isTransientPackageDirectory(rel)) out.push(...await walk(full));
    } else if (isDurablePackagePath(rel)) out.push(full);
  }
  return out;
}

const durableFiles = (await walk(packageRoot))
  .map((file) => ({ file, rel: portableRelative(packageRoot, file) }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

const lines = [];
for (const { file, rel } of durableFiles) {
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  lines.push(`${digest}  ./${rel}`);
}
await writeFile(manifestPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Package SHA ledger written: ${durableFiles.length} durable files.`);
