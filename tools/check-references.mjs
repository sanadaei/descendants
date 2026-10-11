import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledgerPath = path.join(root, 'REFERENCES.txt');
const text = await readFile(ledgerPath, 'utf8');

assert.match(text, /^DESCENDANTS REFERENCE LEDGER\r?$/m);
assert.match(text, /^REFERENCE_LEDGER_VERSION:\s*1\r?$/m);
assert.match(text, /^POLICY_STATUS:\s*REQUIRED_RELEASE_ARTIFACT\r?$/m);
assert.doesNotMatch(text, /\b(?:TODO|TBD|PLACEHOLDER)\b/i, 'reference ledger contains unfinished placeholders');

const blocks = text.split(/^=== REF \d{3} ===\r?$/m).slice(1);
assert.ok(blocks.length >= 15, `reference ledger too small: ${blocks.length}; expected at least 15 substantive references`);

const requiredFields = [
  'TYPE', 'TITLE', 'YEAR', 'URL', 'LICENSE_RIGHTS', 'CONSULTED',
  'DESCENDANTS_USE', 'ADOPTION', 'COPY_STATUS', 'NOTES',
];
const types = new Set();
const urls = new Set();
let sourceCodeCount = 0;
let paperCount = 0;
let standardCount = 0;

for (const [index, block] of blocks.entries()) {
  // Numbered reference fields end when a non-numbered ledger section begins.
  // This keeps the user-provided ZONE_PDA design-source metadata from
  // overwriting REF 095 fields such as ADOPTION/COPY_STATUS.
  const numberedReference = block.split(/^=== .+ ===\r?$/m, 1)[0];
  const fields = new Map();
  for (const line of numberedReference.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+):\s*(.+)$/);
    if (match) fields.set(match[1], match[2].trim());
  }
  for (const field of requiredFields) assert.ok(fields.get(field), `REF ${index + 1} missing ${field}`);
  assert.match(fields.get('URL'), /^https:\/\//, `REF ${index + 1} URL must be https`);
  assert.equal(urls.has(fields.get('URL')), false, `duplicate reference URL: ${fields.get('URL')}`);
  urls.add(fields.get('URL'));
  assert.match(fields.get('CONSULTED'), /^\d{4}-\d{2}-\d{2}$/, `REF ${index + 1} CONSULTED must be YYYY-MM-DD`);
  assert.ok(['ADOPTED', 'PARTIAL', 'REFERENCE_ONLY'].includes(fields.get('ADOPTION')), `REF ${index + 1} invalid ADOPTION`);
  assert.equal(fields.get('COPY_STATUS'), 'NO_CODE_COPIED', `REF ${index + 1} must explicitly state copy status`);
  types.add(fields.get('TYPE'));
  if (fields.get('TYPE') === 'SOURCE_CODE') sourceCodeCount += 1;
  if (fields.get('TYPE') === 'PAPER') paperCount += 1;
  if (fields.get('TYPE') === 'STANDARD') standardCount += 1;
}

for (const requiredType of ['PAPER', 'SOURCE_CODE', 'STANDARD']) assert.ok(types.has(requiredType), `reference ledger missing ${requiredType} entries`);
assert.ok(sourceCodeCount >= 5, `expected >=5 source-code references, got ${sourceCodeCount}`);
assert.ok(paperCount >= 7, `expected >=7 paper references, got ${paperCount}`);
assert.ok(standardCount >= 1, `expected >=1 standards reference, got ${standardCount}`);

console.log(`Research reference gate: PASS (${blocks.length} references; ${paperCount} papers, ${sourceCodeCount} source-code projects, ${standardCount} standards).`);
