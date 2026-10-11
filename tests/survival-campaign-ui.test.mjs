import { readSandboxUiSource } from '../tools/read-sandbox-ui.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('F1 keeps open-ended survival continuity metrics inside the Morning Report command surface', async () => {
  const app = await readSandboxUiSource();
  const command = await read('src/sandbox/dailyCommandReadModel.ts');
  assert.match(app, /deriveSurvivalCampaignView/);
  assert.match(app, /deriveDailyCommandView/);
  assert.match(app, /MORNING REPORT/);
  assert.match(app, /YEAR \${campaign\.currentYear}/);
  assert.doesNotMatch(app, /campaign\.campaignYears/);
  assert.doesNotMatch(app, /campaign\.targetDay/);
  assert.doesNotMatch(app, /campaign\.outcome/);
  assert.match(command, /input\.campaign\.foodDays/);
  assert.match(command, /input\.campaign\.waterDays/);
  assert.match(app, /campaign\.livingDescendants/);
  assert.match(app, /campaign\.milestones\.filter/);
  assert.match(app, /MORNING REPORT/);
});

test('player-facing time progression is committed through BEGIN OPERATIONS rather than a raw day button', async () => {
  const app = await readSandboxUiSource();
  assert.doesNotMatch(app, /data-action="advance" data-hours="24"/);
  assert.doesNotMatch(app, />\+1日<|>\+1 day</);
  assert.match(app, /BEGIN OPERATIONS/);
  assert.match(app, /data-action="execute-plan"/);
});

test('campaign UI has readable HUD milestone and directive styles but no win loss ending panel', async () => {
  const css = await read('src/styles.css');
  assert.match(css, /\.desc-pda-campaign-command/);
  assert.match(css, /\.desc-pda-campaign-metrics/);
  assert.match(css, /\.desc-pda-campaign-milestones/);
  assert.match(css, /\.desc-pda-campaign-directive/);
  assert.doesNotMatch(css, /\.desc-pda-campaign-ending/);
});
