import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');
async function walk(dir, prefix='') {
  const out=[];
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const rel=path.posix.join(prefix,entry.name);
    if (entry.isDirectory()) out.push(...await walk(path.join(dir,entry.name),rel)); else out.push(rel);
  }
  return out;
}
const files=await walk(dist);
for (const required of ['index.html','assets/main.js','assets/sandbox/app.js','assets/worldbridge/realWorldProvider.js','worldgen/runtime-manifest.json']) assert.ok(files.includes(required),`missing generated product file: ${required}`);
for (const rel of files) {
  assert.doesNotMatch(rel, /(^|\/)studio(?:\.|\/)|^assets\/(?:ui|core|lineage)\/|game-content|golden/i, `legacy/authored contamination: ${rel}`);
}
const jsFiles=files.filter((file)=>file.endsWith('.js'));
for (const rel of jsFiles) {
  const text=await readFile(path.join(dist,rel),'utf8');
  assert.doesNotMatch(text,/studio\.html|\?legacy=1|debugScene|new GameApp\b/,`legacy runtime marker in ${rel}`);
}
console.log(`Generated package contamination gate: PASS (${files.length} files, 0 Studio/authored-runtime files).`);
