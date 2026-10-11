import { readSandboxUiSource } from '../tools/read-sandbox-ui.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const app = await readSandboxUiSource();

test('F4 exposes detailed provenance lots and source quality instead of only scalar stock', ()=>{
  for (const token of ['RESOURCE LOTS','data-resource-lot-id','SOURCE / PROVENANCE','freshness','contamination','water quality','Custody']) {
    assert.ok(app.includes(token), `missing F4 resource detail token: ${token}`);
  }
});

test('F4 lets player build reusable ration groups from the resident roster', ()=>{
  for (const token of ['配給グループ','data-action="ration-member-toggle"','data-action="ration-group-name"','data-action="ration-group-save"','data-action="ration-group-delete"']) {
    assert.ok(app.includes(token), `missing ration group control: ${token}`);
  }
});

test('F4 lets player assign a lot or subtype to a saved group and configure exclusivity', ()=>{
  for (const token of ['配給ルール','data-action="ration-rule-group"','data-action="ration-rule-resource"','data-action="ration-rule-selector"','data-action="ration-rule-exclusive"','data-action="ration-rule-save"','data-action="ration-rule-delete"']) {
    assert.ok(app.includes(token), `missing ration rule control: ${token}`);
  }
});

test('F4 displays recent per-person distribution history', ()=>{
  for (const token of ['配給履歴','recentDistributions','data-distribution-id']) {
    assert.ok(app.includes(token), `missing distribution history token: ${token}`);
  }
});
