import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = await readFile(path.join(root, 'src/sandbox/app.ts'), 'utf8');
const css = await readFile(path.join(root, 'src/styles.css'), 'utf8');
const audio = await readFile(path.join(root, 'src/sandbox/pdaAudio.ts'), 'utf8');

async function walk(dir) {
  const out=[];
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const full=path.join(dir,entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('ZONE_PDA CRT vocabulary remains present with scanlines, RGB columns, flicker, vignette and glass', () => {
  assert.match(css, /background-size:100% 3px,3px 100%/);
  assert.match(css, /rgba\(255,0,0,\.02\).*rgba\(0,255,0,\.01\).*rgba\(0,0,255,\.02\)/s);
  assert.match(css, /animation:descPdaFlicker \.12s infinite/);
  assert.match(css, /inset 0 0 35px rgba\(0,0,0,\.85\),inset 0 0 80px rgba\(0,0,0,\.6\)/);
  assert.match(css, /linear-gradient\(135deg,rgba\(255,255,255,\.04\),rgba\(255,255,255,\.01\) 30%,transparent 50%\)/);
  assert.match(app, /data-action="pda-scanlines"/);
  assert.match(app, /data-action="pda-flicker"/);
});

test('terminal audio preserves synthesized click, tab, confirm, warning, static and sensor sound vocabulary', () => {
  assert.match(audio, /osc\.frequency\.setValueAtTime\(1400/);
  assert.match(audio, /osc1\.frequency\.setValueAtTime\(1800/);
  assert.match(audio, /osc\.frequency\.setValueAtTime\(880/);
  assert.match(audio, /osc\.frequency\.setValueAtTime\(120/);
  assert.match(audio, /createBufferSource\(\)/);
  assert.match(audio, /3000 \+ Math\.random\(\) \* 1500/);
  assert.doesNotMatch(audio, /fetch\(|new Audio\(|\.mp3|\.wav|\.ogg/i);
  assert.match(app, /data-action="pda-audio-master"/);
  assert.match(app, /data-action="pda-audio-sensor"/);
  assert.match(app, /data-action="pda-audio-test"/);
});

test('audio and CRT controls are routed while Reduced Motion can suppress flicker animation', () => {
  for (const action of ['pda-audio-mute','pda-audio-test','pda-scanlines','pda-flicker','pda-audio-sensor-ticks']) {
    assert.match(app, new RegExp(`action===['"]${action}['"]|dataset\\.action===['"]${action}['"]`));
  }
  assert.match(app, /this\.#pdaPresentation\.flicker&&!this\.#accessibility\.reduceMotion/);
  assert.match(css, /a11y-reduce-motion .*desc-pda-crt-flicker/);
});

test('portable production payload contains no prohibited concrete ZONE_PDA image assets', async () => {
  const files = await walk(path.join(root, 'dist'));
  const imageFiles = files.filter((file)=>/\.(?:png|jpe?g|webp)$/i.test(file));
  assert.deepEqual(imageFiles, []);
  const prohibited = /zone_map|stalker_portrait|equip_(?:rifle|mask|suit|detector)|task_(?:bunker|tunnel|factory)|artifact_relic|mutant_snork/i;
  for (const file of files.filter((file)=>/\.(?:html|js|css|json|txt)$/i.test(file))) {
    const text = await readFile(file, 'utf8').catch(()=>null);
    if (text !== null) assert.doesNotMatch(text, prohibited, path.relative(root,file));
  }
});

test('F1 campaign keeps Daily Command scrollable without collapsing the playable task area', () => {
  assert.match(css, /\.desc-pda-campaign-screen\{[^}]*grid-template-rows:minmax\(0,2fr\) minmax\(0,3fr\)[^}]*overflow:hidden/);
  assert.match(css, /\.desc-pda-campaign-command\{[^}]*min-height:0[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/);
  assert.match(css, /\.desc-pda-campaign-screen>\.desc-pda-task-layout\{[^}]*min-height:0[^}]*height:100%/);
  assert.match(css, /\.desc-pda-campaign-screen \.desc-pda-task-detail\{[^}]*min-height:0[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/);
  assert.doesNotMatch(css, /\.desc-pda-campaign-screen\{[^}]*grid-template-rows:auto minmax\(0,1fr\)/);
});

test('Daily Command Center enters compact hierarchy at 1280-class viewports', () => {
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-daily-priority-list\{grid-template-columns:1fr\}/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-daily-resource-summary\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-daily-roster>label\{grid-template-columns:minmax\(150px,1fr\) 105px\}/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-daily-readiness\{grid-template-columns:1fr\}/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-morning-row>\*:nth-child\(6\),\.desc-morning-row>\*:nth-child\(7\),\.desc-morning-row>\*:nth-child\(8\)\{display:none\}/);
});

test('Daily Command priority cards expand to fill available wide-screen space', () => {
  assert.match(css, /\.desc-daily-priority-list\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(280px,1fr\)\);gap:5px\}/);
});

test('1280-class Daily Plan keeps readiness and execute control within the compact jump viewport', () => {
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-daily-roster\{max-height:205px\}/);
});

test('P27 command effects are synthesized, reduced-motion safe, and compact at 1280-class widths', () => {
  assert.match(audio, /playCommandCommit\(\)/);
  assert.doesNotMatch(audio, /fetch\(|new Audio\(|\.mp3|\.wav|\.ogg/i);
  assert.match(css, /\.desc-command-execution-curtain/);
  assert.match(css, /a11y-reduce-motion[\s\S]*?desc-command-execution-curtain/);
  assert.match(css, /prefers-reduced-motion[\s\S]*?desc-command-execution-curtain/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-command-signal/);
});


test('P29 assignment readback trace is reduced-motion safe, high-contrast legible, and compact at 1280-class widths', () => {
  assert.match(css, /\.desc-assignment-readback/);
  assert.match(css, /\.desc-assignment-trace/);
  assert.match(css, /a11y-reduce-motion[\s\S]*?desc-assignment-readback/);
  assert.match(css, /prefers-reduced-motion[\s\S]*?desc-assignment-readback/);
  assert.match(css, /a11y-contrast[\s\S]*?desc-assignment-readback/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?desc-assignment-readback/);
});

test('P30 morning replan is reduced-motion safe, high-contrast legible, and compact at 1280-class widths', () => {
  for (const token of ['.desc-morning-replan', '.desc-morning-replan-grid', '.desc-morning-replan-card', '.desc-morning-replan-route', '.desc-morning-replan-actions']) {
    assert.ok(css.includes(token), `missing P30 CSS token: ${token}`);
  }
  assert.match(css, /a11y-reduce-motion[\s\S]*?desc-morning-replan/);
  assert.match(css, /prefers-reduced-motion[\s\S]*?desc-morning-replan/);
  assert.match(css, /a11y-contrast[\s\S]*?desc-morning-replan/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?desc-morning-replan-grid\{grid-template-columns:1fr/);
});

test('P31 survival instruments are rich, categorical, reduced-motion safe, high-contrast legible, and compact', () => {
  for (const token of ['.desc-survival-telemetry', '.desc-survival-instrument', '.desc-instrument-value', '.desc-instrument-detail', '.desc-instrument-trend', '.desc-instrument-pressure']) {
    assert.ok(css.includes(token), `missing P31 CSS token: ${token}`);
  }
  assert.match(css, /@keyframes\s+descTelemetryAcquire/);
  assert.match(css, /a11y-reduce-motion[\s\S]*?desc-survival-instrument/);
  assert.match(css, /prefers-reduced-motion[\s\S]*?desc-survival-instrument/);
  assert.match(css, /a11y-contrast[\s\S]*?desc-survival-instrument/);
  assert.match(css, /@media\(max-width:1300px\)[\s\S]*?\.desc-daily-resource-summary\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.doesNotMatch(css, /--resource-progress|--telemetry-progress|width:\s*var\(--(?:resource|telemetry)/);
});
