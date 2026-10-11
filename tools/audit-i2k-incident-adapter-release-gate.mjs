import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const service = await readFile(new URL('../src/sandbox/incidentService.ts', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/sandbox/app.ts', import.meta.url), 'utf8');
const evidenceUrl = new URL('../I2K_HUMAN_VISUAL_ACCEPTANCE.json', import.meta.url);

assert.ok(service.includes("globalThis.localStorage.getItem(I2_F1_INCIDENT_STORAGE_KEY) === '1'"), 'Incident adapter is no longer explicit opt-in');
assert.ok(service.includes('Feature-flagged F1 adapter. Default OFF.'), 'Default-OFF contract marker missing');
assert.ok(app.includes("?'ON':'OFF (SAFE DEFAULT)'"), 'F10 safe-default label missing');

let evidence = null;
try {
  await access(evidenceUrl, constants.R_OK);
  evidence = JSON.parse(await readFile(evidenceUrl, 'utf8'));
} catch { /* absence is the expected safe-blocked state */ }

const acceptedWidths = new Set(Array.isArray(evidence?.verifiedWidths) ? evidence.verifiedWidths : []);
const evidencePass = evidence?.status === 'PASS'
  && [1440, 900, 620].every((width)=>acceptedWidths.has(width))
  && evidence?.keyboardNavigation === true
  && evidence?.highContrast === true
  && evidence?.touchTargets === true
  && typeof evidence?.reviewedBy === 'string' && evidence.reviewedBy.trim().length > 0;

if (!evidencePass) {
  console.log(JSON.stringify({
    status: 'SAFE_BLOCKED',
    promotionAllowed: false,
    adapterDefault: 'OFF',
    reason: evidence ? 'visual-acceptance-incomplete-or-invalid' : 'I2K_HUMAN_VISUAL_ACCEPTANCE.json absent',
    requiredVisualAcceptance: { widths: [1440,900,620], keyboardNavigation: true, highContrast: true, touchTargets: true, humanReviewerRequired: true },
  }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify({
  status: 'READY_FOR_EXPLICIT_PROMOTION_DECISION',
  promotionAllowed: false,
  adapterDefault: 'OFF',
  note: 'Visual acceptance is present, but this gate never mutates the default. A separate explicit release decision and code change are still required.',
}, null, 2));
