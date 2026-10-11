import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'dist'), { recursive: true });
await mkdir(resolve(root, 'dist', 'assets'), { recursive: true });
await writeFile(resolve(root, 'dist', 'assets', 'styles.css'), await readFile(resolve(root, 'src', 'styles.css')));
let html = await readFile(resolve(root, 'index.html'), 'utf8');
html = html.replace('/src/styles.css', './assets/styles.css').replace('/src/main.ts', './assets/main.js');
await writeFile(resolve(root, 'dist', 'index.html'), html, 'utf8');
await cp(resolve(root, 'public', 'worldgen'), resolve(root, 'dist', 'worldgen'), { recursive: true, force: true });
console.log('Built generated-world portable static payload (Studio/authored Adventure assets excluded).');
