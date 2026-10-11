#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ContentPackRegistry, buildLoreCorpus, parseWorldRecipe } from '../dist/index.js';

const args = process.argv.slice(2);
const allowUnverified = args.includes('--allow-unverified');
const allowUnreviewed = args.includes('--allow-unreviewed');
const dryRun = args.includes('--dry-run');
const positional = args.filter((arg) => arg !== '--allow-unverified' && arg !== '--allow-unreviewed' && arg !== '--dry-run');
const [recipeArg = 'setting-packs/descendants/default.recipe.json', outputArg = 'research/lore-materials/raw'] = positional;
const recipePath = resolve(recipeArg);
const outputDir = resolve(outputArg);
const recipe = parseWorldRecipe(await readFile(recipePath, 'utf8'));
const registry = new ContentPackRegistry();
for (const ref of recipe.contentPacks) {
  const packPath = join(dirname(recipePath), 'content-packs', `${ref.id}.json`);
  try { registry.register(JSON.parse(await readFile(packPath, 'utf8'))); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
registry.validateReferences(recipe.contentPacks);
const corpus = buildLoreCorpus(registry);
if (corpus.errors.length) throw new Error(corpus.errors.join('\n'));
await mkdir(outputDir, { recursive: true });

function candidateUrls(source) {
  const catalogUrl = source.verificationUrl ?? source.accessUrl;
  if (!catalogUrl) return [];
  const match = catalogUrl.match(/gutenberg\.org\/ebooks\/(\d+)/);
  if (!match) return [catalogUrl];
  const id = match[1];
  return [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/files/${id}/${id}-8.txt`,
    `https://www.gutenberg.org/files/${id}/${id}.txt`,
  ];
}

const manifest = [];
for (const source of corpus.sources.filter((item) => item.ingestionPolicy === 'public-domain-text')) {
  if (!allowUnverified && source.verificationStatus !== 'verified-catalog') {
    manifest.push({ sourceId: source.id, status: 'skipped-unverified', verificationStatus: source.verificationStatus ?? 'provisional', reason: 'External catalog verification is required before raw-text acquisition.' });
    continue;
  }
  if (!allowUnreviewed && source.curationReviewStatus !== 'metadata-reviewed') {
    manifest.push({ sourceId: source.id, status: 'skipped-unreviewed', curationReviewStatus: source.curationReviewStatus ?? 'none', reason: 'Metadata/mediation review is required before raw-text acquisition.' });
    continue;
  }
  if (!allowUnreviewed && !source.rightsJurisdiction) {
    manifest.push({ sourceId: source.id, status: 'skipped-rights-review', reason: 'Item-level rights jurisdiction must be recorded before raw-text acquisition.' });
    continue;
  }
  if (dryRun) {
    manifest.push({ sourceId: source.id, status: 'planned', verificationUrl: source.verificationUrl, rightsJurisdiction: source.rightsJurisdiction, candidates: candidateUrls(source) });
    continue;
  }
  const destination = join(outputDir, `${source.id}.txt`);
  let prior = false;
  try { await access(destination); prior = true; } catch {}
  if (prior) {
    const bytes = await readFile(destination);
    manifest.push({ sourceId: source.id, status: 'cached', verificationUrl: source.verificationUrl, rightsJurisdiction: source.rightsJurisdiction, file: basename(destination), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    continue;
  }
  let errorText = '';
  let saved = false;
  for (const url of candidateUrls(source)) {
    try {
      const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'worldgen-lore-corpus-builder/1.1' } });
      if (!response.ok) { errorText = `HTTP ${response.status}`; continue; }
      const text = await response.text();
      if (text.length < 500) { errorText = 'response too short'; continue; }
      await writeFile(destination, text, 'utf8');
      const bytes = Buffer.from(text, 'utf8');
      manifest.push({ sourceId: source.id, status: 'fetched', sourceUrl: url, verificationUrl: source.verificationUrl, rightsJurisdiction: source.rightsJurisdiction, file: basename(destination), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      saved = true;
      break;
    } catch (error) { errorText = String(error?.message ?? error); }
  }
  if (!saved) manifest.push({ sourceId: source.id, status: 'failed', error: errorText, candidates: candidateUrls(source) });
}
await writeFile(join(outputDir, 'manifest.json'), JSON.stringify({ recipeId: recipe.id, sourceCount: manifest.length, items: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ outputDir, dryRun, fetched: manifest.filter((item) => item.status === 'fetched').length, cached: manifest.filter((item) => item.status === 'cached').length, skippedUnverified: manifest.filter((item) => item.status === 'skipped-unverified').length, skippedUnreviewed: manifest.filter((item) => item.status === 'skipped-unreviewed').length, skippedRightsReview: manifest.filter((item) => item.status === 'skipped-rights-review').length, failed: manifest.filter((item) => item.status === 'failed').length, allowUnverified, allowUnreviewed }, null, 2));
