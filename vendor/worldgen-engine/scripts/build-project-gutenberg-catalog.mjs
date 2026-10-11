#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const inputPath = resolve(process.argv[2] ?? 'research/lore-materials/catalog/project-gutenberg-mythology-labels.tsv');
const outputPath = resolve(process.argv[3] ?? 'setting-packs/descendants/content-packs/project-gutenberg-mythology-catalog.json');
const minimumUnique = Number(process.env.WORLDGEN_MIN_CATALOG_RECORDS ?? 1000);

function hash(value) { return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16); }
function normalizeLabel(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\([^)]*(?:german|french|spanish|danish|finnish|hungarian|italian|latin|greek|haida)[^)]*\)/g, ' ')
    .replace(/\b(?:vol(?:ume)?|tome|part|book|series)\.?\s*(?:[ivxlcdm]+|\d+)(?:\s+of\s+(?:[ivxlcdm]+|\d+))?\b/g, ' ')
    .replace(/\b(?:first|second|third|fourth|fifth)\s+(?:series|edition)\b/g, ' ')
    .replace(/\b(?:illustrated|complete|edition)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function pageStart(position) { return Math.floor((position - 1) / 25) * 25 + 1; }

const lines = (await readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean);
if (lines.shift() !== 'position\traw_catalog_label') throw new Error(`Unexpected TSV header in ${inputPath}`);
const rows = lines.map((line) => {
  const tab = line.indexOf('\t');
  if (tab < 0) throw new Error(`Malformed TSV row: ${line}`);
  return { position: Number(line.slice(0, tab)), rawLabel: line.slice(tab + 1).trim() };
}).filter((row) => Number.isInteger(row.position) && row.position > 0 && row.rawLabel);
rows.sort((a, b) => a.position - b.position);

const byLabel = new Map();
for (const row of rows) {
  const list = byLabel.get(row.rawLabel) ?? [];
  list.push(row.position); byLabel.set(row.rawLabel, list);
}
if (byLabel.size < minimumUnique) throw new Error(`Catalog hard gate failed: ${byLabel.size} unique raw labels < ${minimumUnique}`);

const sourceCatalog = [...byLabel.entries()].map(([rawLabel, positions]) => {
  const first = positions[0];
  const normalizedFamily = normalizeLabel(rawLabel) || rawLabel.toLowerCase();
  const url = `https://www.gutenberg.org/ebooks/bookshelf/646?sort_order=title&start_index=${pageStart(first)}`;
  return {
    id: `pg-myth-${hash(rawLabel)}`,
    title: rawLabel,
    creators: [],
    traditions: ['unclassified'],
    domains: ['mythology', 'folklore', 'catalog'],
    sourceKind: 'archive',
    ingestionPolicy: 'metadata-only',
    accessUrl: url,
    rightsNote: 'Catalog metadata only. Inclusion does not establish the rights status of the underlying text in the user jurisdiction.',
    collectionContext: 'Project Gutenberg bookshelf “Mythology, Legends & Folklore”, title-sorted provider page snapshot. rawCatalogLabel is retained verbatim; title/creator boundaries are intentionally unresolved until metadata review.',
    translationContext: 'Not reviewed at catalog-only stage.',
    editionContext: 'Not reviewed at catalog-only stage; Project Gutenberg metadata may not identify the exact source edition used for an ebook.',
    sensitivityNotes: ['Catalog classification is a provider-level discovery aid, not an assertion that the record represents an independent tradition or primary ethnographic witness.'],
    biasNotes: ['Project Gutenberg availability, digitization history, language coverage, and bookshelf classification create strong selection bias.'],
    curationReviewStatus: 'catalog-only',
    verificationStatus: 'provisional',
    verificationUrl: url,
    verificationCheckedAt: '2026-09-08',
    providerId: 'project-gutenberg',
    rawCatalogLabel: rawLabel,
    catalogPosition: first,
    ...(positions.length > 1 ? { catalogDuplicatePositions: positions.slice(1) } : {}),
    catalogUrl: url,
    catalogCategory: 'Mythology, Legends & Folklore',
    catalogVerificationStatus: 'provider-page-verified',
    bibliographicFamilyId: `pg-family-${hash(normalizedFamily)}`,
    bibliographicParseStatus: 'catalog-label-only',
    evidenceRole: 'catalog-context'
  };
}).sort((a, b) => a.catalogPosition - b.catalogPosition || a.id.localeCompare(b.id));

const pack = {
  id: 'project-gutenberg-mythology-catalog',
  version: '0.1.0',
  data: {
    loreCorpus: { sourceCatalog },
    catalogManifest: {
      providerId: 'project-gutenberg',
      providerCategory: 'Mythology, Legends & Folklore',
      providerCategoryUrl: 'https://www.gutenberg.org/ebooks/bookshelf/646',
      snapshotDate: '2026-09-08',
      rawSnapshotRecordCount: rows.length,
      uniqueRawLabelCount: byLabel.size,
      exactDuplicateLabelRows: rows.length - byLabel.size,
      minimumUniqueRecordGate: minimumUnique,
      evidencePolicy: 'catalog-only records are discovery metadata and MUST NOT count as motif/transformation/transmission evidence until metadata/evidence review promotes them.'
    }
  }
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(pack, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ inputPath, outputPath, rawSnapshotRecords: rows.length, uniqueRawLabels: byLabel.size, generatedSources: sourceCatalog.length, exactDuplicateLabelRows: rows.length - byLabel.size, hardGate: sourceCatalog.length >= minimumUnique }, null, 2));
