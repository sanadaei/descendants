import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const service = await readFile(new URL('../src/sandbox/incidentService.ts', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/sandbox/app.ts', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const visualUrl = new URL('../I2K_HUMAN_VISUAL_ACCEPTANCE.json', import.meta.url);
const decisionUrl = new URL('../I2L_EXPLICIT_RELEASE_DECISION.json', import.meta.url);

const machineChecks = {
  adapterExplicitOptIn: service.includes("globalThis.localStorage.getItem(I2_F1_INCIDENT_STORAGE_KEY) === '1'"),
  defaultOffMarker: service.includes('Feature-flagged F1 adapter. Default OFF.'),
  safeDefaultLabel: app.includes("?'ON':'OFF (SAFE DEFAULT)'"),
  factSearchPresent: app.includes('data-action="incident-debrief-search"'),
  factTimelinePresent: app.includes('TIMELINE FACTS'),
  i2kReleaseGateScriptPresent: typeof pkg.scripts?.['audit:i2k-release-gate'] === 'string',
  i2lFactAuditScriptPresent: typeof pkg.scripts?.['audit:i2l-f1-facts'] === 'string',
  i2lReleaseChecklistScriptPresent: typeof pkg.scripts?.['audit:i2l-release-checklist'] === 'string',
};
assert.ok(Object.values(machineChecks).every(Boolean), 'I2-L machine release checklist is incomplete');

async function optionalJson(url) {
  try { await access(url, constants.R_OK); return JSON.parse(await readFile(url,'utf8')); }
  catch { return null; }
}
const visual = await optionalJson(visualUrl);
const decision = await optionalJson(decisionUrl);
const widths = new Set(Array.isArray(visual?.verifiedWidths) ? visual.verifiedWidths : []);
const visualAccepted = visual?.status === 'PASS'
  && [1440,900,620].every((width)=>widths.has(width))
  && visual?.keyboardNavigation === true
  && visual?.highContrast === true
  && visual?.touchTargets === true
  && typeof visual?.reviewedBy === 'string' && visual.reviewedBy.trim().length>0;
const explicitDecisionAccepted = decision?.status === 'APPROVED'
  && decision?.target === 'incident-adapter-default-on'
  && typeof decision?.reviewedBy === 'string' && decision.reviewedBy.trim().length>0
  && typeof decision?.decisionAt === 'string' && decision.decisionAt.trim().length>0;

const blockers=[];
if (!visualAccepted) blockers.push(visual ? 'human-visual-acceptance-invalid-or-incomplete' : 'human-visual-acceptance-absent');
if (!explicitDecisionAccepted) blockers.push(decision ? 'explicit-release-decision-invalid-or-incomplete' : 'explicit-release-decision-absent');
const readyForCodeChange = blockers.length===0;
console.log(JSON.stringify({
  status: readyForCodeChange ? 'READY_FOR_EXPLICIT_DEFAULT_CODE_CHANGE' : 'SAFE_BLOCKED',
  machineChecklistPassed:true,
  promotionAllowed:false,
  adapterDefault:'OFF',
  machineChecks,
  blockers,
  requiredHumanVisualAcceptance:{widths:[1440,900,620],keyboardNavigation:true,highContrast:true,touchTargets:true,humanReviewerRequired:true},
  requiredExplicitDecision:{status:'APPROVED',target:'incident-adapter-default-on',humanReviewerRequired:true,decisionTimestampRequired:true},
  note:'This checklist never mutates the adapter default. Even a blocker-free result only authorizes a separate reviewed code change followed by full verification.',
},null,2));
