#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import {
  ContentPackRegistry, createBuiltinRegistry, parseWorldRecipe, WorldgenEngine,
  diagnoseDeterministicReplay, serializeSnapshot, validateSnapshotConformance, buildLoreCorpus, auditLoreCorpus,
} from './dist/index.js';

async function loadContentPacks(recipe, absoluteRecipePath) {
  const registry = new ContentPackRegistry();
  for (const ref of recipe.contentPacks) {
    const path = join(dirname(absoluteRecipePath), 'content-packs', `${ref.id}.json`);
    try {
      const pack = JSON.parse(await readFile(path, 'utf8'));
      registry.register(pack);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return registry;
}

const [command, recipePath, outputPath] = process.argv.slice(2);
if (!command || !recipePath) {
  console.error('Usage: node cli.mjs <generate|diagnose|validate-recipe|audit-lore> <recipe.json> [output.json]');
  process.exitCode = 2;
} else {
  const absoluteRecipePath = resolve(recipePath);
  const recipe = parseWorldRecipe(await readFile(absoluteRecipePath, 'utf8'));
  const content = await loadContentPacks(recipe, absoluteRecipePath);
  const engine = new WorldgenEngine(createBuiltinRegistry(), content);
  if (command === 'audit-lore') {
    if (content.list().length === 0) throw new Error('audit-lore requires content packs beside the recipe');
    content.validateReferences(recipe.contentPacks);
    const corpus = buildLoreCorpus(content);
    console.log(JSON.stringify({ valid: corpus.errors.length === 0, errors: corpus.errors, warnings: corpus.warnings, sources: corpus.sources.length, motifs: corpus.motifs.length, transformations: corpus.transformations.length, transmissionModes: corpus.transmissionModes.length, policies: Object.fromEntries([...new Set(corpus.sources.map((source) => source.ingestionPolicy))].sort().map((policy) => [policy, corpus.sources.filter((source) => source.ingestionPolicy === policy).length])), quality: auditLoreCorpus(corpus) }, null, 2));
    if (corpus.errors.length) process.exitCode = 1;
  } else if (command === 'validate-recipe') {
    if (content.list().length > 0) content.validateReferences(recipe.contentPacks);
    console.log(JSON.stringify({ valid: true, recipeId: recipe.id, loadedContentPacks: content.list().map((pack) => `${pack.id}@${pack.version}`) }, null, 2));
  } else if (command === 'diagnose') {
    console.log(JSON.stringify(await diagnoseDeterministicReplay(recipe, engine), null, 2));
  } else if (command === 'generate') {
    const world = await engine.generate(recipe);
    const snapshot = await world.exportSnapshot();
    const errors = validateSnapshotConformance(snapshot);
    if (errors.length) throw new Error(`Snapshot conformance failed:\n${errors.join('\n')}`);
    if (outputPath) {
      const destination = resolve(outputPath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, serializeSnapshot(snapshot));
      console.log(JSON.stringify({ recipeId: recipe.id, output: destination, entities: snapshot.entities.length, events: snapshot.events.length, knowledge: snapshot.knowledge.length, contentPacks: content.list().length }, null, 2));
    } else {
      console.log(serializeSnapshot(snapshot));
    }
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}
