import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const read=(rel)=>readFile(path.join(root,rel),'utf8');

test('generated-world shell promotes F1-F5 surfaces inside the Descendants terminal UI', async()=>{
  const app=await read('src/sandbox/app.ts');
  const css=await read('src/styles.css');
  for(const pair of [['exploration','F1'],['body','F2'],['knowledge','F3'],['inventory','F4'],['chronicle','F5']]) {
    assert.match(app,new RegExp(`'${pair[0]}'[^\\n]+'${pair[1]}'`));
  }
  assert.match(app,/desc-pda-hardware/);
  assert.match(app,/type PdaTab = .*'map'.*'residents'.*'system'/);
  assert.match(app,/DESCENDANTS FIELD TERMINAL/);
  assert.match(app,/pdaExpeditionPreparation/);
  assert.match(app,/data-action="pda-task-panel"/);
  assert.match(app,/desc-pda-secondary-index/);
  assert.match(css,/\.generated-game-shell/);
  assert.doesNotMatch(app,/type ViewId = .*expeditions/);
});

test('remote UI uses report/viewpoint projections instead of direct hidden expedition truth', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/REMOTE \/ CURRENT STATUS UNKNOWN/);
  assert.match(app,/chronicleViewpoint/);
  assert.match(app,/projectChronicle/);
  assert.match(app,/Launch search from last verified route evidence/);
  assert.doesNotMatch(app,/exp\.lossState/);
});

test('production bootstrap has no authored Adventure or Studio route', async()=>{
  const main=await read('src/main.ts');
  assert.match(main,/SandboxApp/);
  assert.match(main,/createRealWorldRuntime/);
  assert.doesNotMatch(main,/legacy|debugScene|GameApp|studio/i);
});

test('portable build copies only generated-world static support', async()=>{
  const copy=await read('tools/copy-static.mjs');
  const portable=await read('tsconfig.portable.json');
  assert.match(copy,/public', 'worldgen/);
  assert.doesNotMatch(copy,/cp\(resolve\(root, 'public'\),/);
  assert.match(portable,/"include": \["src\/main\.ts"\]/);
});

test('generated direct-play UI binds LOCAL projection, physical samples and equipment without quest omniscience', async()=>{
  const app=await read('src/sandbox/app.ts');
  const local=await read('src/sandbox/localExploration.ts');
  const direct=await read('src/sandbox/directPlay.ts');
  assert.match(app,/FIELD ACTIONS \/ CURRENT RANGE/);
  assert.match(app,/queryGeneratedLocalArea/);
  assert.match(app,/observe-local-target/);
  assert.match(app,/sample-local-target/);
  assert.match(app,/toggle-equipment/);
  assert.match(app,/physically accessible stock/i);
  assert.match(local,/observerId/);
  assert.match(local,/includeKnowledgeProjection: true/);
  assert.match(local,/promoteToSettlement: false/);
  assert.match(direct,/sample-source:/);
  assert.match(direct,/equipment:skill:/);
});

test('F3 read-switch candidate is feature-gated, fail-closed, and feeds the existing F3 renderer without changing action IDs', async()=>{
  const app=await read('src/sandbox/app.ts');
  const projection=await read('src/sandbox/knowledgeF3Projection.ts');
  assert.match(app,/selectF3KnowledgeReadModel\(this\.state, holder\?\.id \?\? null\)/);
  assert.match(app,/const personal = f3Read\.personal/);
  assert.match(app,/const institutional = f3Read\.institutional/);
  assert.match(projection,/descendants\.i1c\.f3-read-v2\.v1/);
  assert.match(projection,/falling back to legacy F3 read/);
  assert.match(projection,/source: 'shadow'/);
});

test('I1-D compare remains feature-gated while I1-D2 may select the shadow WORLD read only through the fail-closed selector', async()=>{
  const app=await read('src/sandbox/app.ts');
  const graph=await read('src/sandbox/knowledgeGraphProjection.ts');
  assert.match(app,/compareWorldGraphProjectionsIfEnabled\(this\.state, controlled\.id, this\.#worldProjection\)/);
  assert.match(app,/selectWorldGraphReadModel\(this\.state, controlled\.id, this\.#worldProjection\)/);
  assert.match(app,/return read\.entities/);
  assert.match(graph,/descendants\.i1d\.world-compare\.v1/);
  assert.match(graph,/descendants\.i1d\.world-read-v2\.v1/);
  assert.match(graph,/Compare-only diagnostic hook/);
  assert.match(graph,/fail-closed WORLD read selector/);
  assert.match(graph,/legacyKnowledgeShadowSnapshot/);
});

test('F3 exposes co-located conversation, explicit Archive promotion and sample-gated research', async()=>{
  const app=await read('src/sandbox/app.ts');
  const knowledge=await read('src/sandbox/knowledgeSimulation.ts');
  const research=await read('src/sandbox/researchSimulation.ts');
  assert.match(app,/Knowledge \/ Conversation \/ Archive/);
  assert.match(app,/data-action="conversation"/);
  assert.match(app,/data-action="archive-knowledge"/);
  assert.match(app,/Physical sample required at settlement/);
  assert.match(knowledge,/Direct conversation requires both people to be in the same physical context/);
  assert.match(knowledge,/institutionalizeKnowledgeRecord/);
  assert.match(research,/researchSampleGate/);
  assert.match(research,/physical sample to be present at the settlement research context/);
});

test('F1 expedition preparation exposes editable crew loadout pace and doctrine instead of a hard-coded suggested party', async()=>{
  const app=await read('src/sandbox/app.ts');
  const expedition=await read('src/sandbox/expeditionSimulation.ts');
  assert.match(app,/EXPEDITION PREPARATION/);
  assert.match(app,/data-action="prep-crew"/);
  assert.match(app,/data-action="prep-supply"/);
  assert.match(app,/data-action="prep-pace"/);
  assert.match(app,/data-action="prep-doctrine"/);
  assert.match(app,/data-action="doctrine-field"/);
  assert.doesNotMatch(app,/Suggested crew:/);
  assert.match(expedition,/paceSpeed/);
  assert.match(expedition,/paceRisk/);
});

test('F1 exposes coordinate WORLD-LOCAL switching, direct camp/WEDO and observed situation synthesis', async()=>{
  const app=await read('src/sandbox/app.ts');
  const local=await read('src/sandbox/localExploration.ts');
  const expedition=await read('src/sandbox/expeditionSimulation.ts');
  const situations=await read('src/sandbox/situationSynthesis.ts');
  assert.match(app,/data-action="map-scope"/);
  assert.match(app,/data-action="select-world-entity"/);
  assert.match(app,/data-action="set-prep-target"/);
  assert.match(app,/data-action="direct-camp"/);
  assert.match(app,/data-action="wedo-round"/);
  assert.match(app,/synthesizeVisibleSituations/);
  assert.match(local,/queryGeneratedWorldArea/);
  assert.match(expedition,/campExpedition/);
  assert.match(expedition,/resolveControlledEncounterRound/);
  assert.match(situations,/communicationReports/);
  assert.doesNotMatch(situations,/lossState/);
});




test('politics, external society actions and anomaly practice remain reachable inside F1-F3 instead of dead legacy subviews', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/settlementPolicyPanel\(\)/);
  assert.match(app,/ASSEMBLY \/ LABOR PRIORITIES/);
  assert.match(app,/world-selected-actions/);
  assert.match(app,/data-action="external"/);
  assert.match(app,/data-action="anomaly-use"/);
  assert.match(app,/Anomaly-utilization practices/);
  assert.doesNotMatch(app,/private medicineView\(\)/);
  assert.doesNotMatch(app,/private knowledgeView\(\)/);
  assert.doesNotMatch(app,/private worldView\(\)/);
});

test('every rendered generated-world data-action is routed and busy updates serialize mutations', async()=>{
  const app=await read('src/sandbox/app.ts');
  const rendered=[...app.matchAll(/data-action=["']([^"']+)/g)].map((match)=>match[1]).filter((action)=>!action.startsWith('${'));
  const clickHandled=new Set([...app.matchAll(/action===["']([^"']+)["']/g)].map((match)=>match[1]));
  const changeHandled=new Set([...app.matchAll(/\[data-action=["']([^"']+)["']\]/g)].map((match)=>match[1]));
  const routed=new Set([...clickHandled,...changeHandled]);
  const missing=[...new Set(rendered)].filter((action)=>!routed.has(action));
  assert.deepEqual(missing,[],`unrouted generated-world UI actions: ${missing.join(', ')}`);
  assert.match(app,/指令処理中です。完了まで次の操作は保留されます。/);
  assert.match(app,/isBusySafeUiAction/);
  assert.match(app,/if \(this\.#busy[^\n]+this\.toast\('指令処理中です。現在の行動が完了するまで待機してください。/);
  assert.doesNotMatch(app,/private settlementView\(\)/);
  assert.doesNotMatch(app,/private peopleView\(\)/);
  assert.match(app,/ACTIVE COMMAND HOLDER/);
  assert.match(app,/proposeLaborPriority\(this\.state,[^;]+proposer\.id\)/);
});


test('keyboard/focus accessibility contract preserves focus across renders and supplies tab semantics', async()=>{
  const app=await read('src/sandbox/app.ts');
  const css=await read('src/styles.css');
  assert.match(app,/role="tablist"/);
  assert.match(app,/role="tab"/);
  assert.match(app,/aria-selected=/);
  assert.match(app,/role="tabpanel"/);
  assert.match(app,/aria-labelledby="sandbox-tab-/);
  assert.match(app,/focusSelectorFor/);
  assert.match(app,/restoreFocus/);
  assert.match(app,/focus\(\{ preventScroll: true \}\)/);
  assert.match(app,/ArrowLeft','ArrowRight','Home','End/);
  assert.match(app,/viewForFunctionKey/);
  assert.match(css,/button:focus-visible,input:focus-visible,select:focus-visible/);
  assert.match(css,/sandbox-skip-link:focus/);
  assert.match(app,/role="status" aria-live="polite" aria-atomic="true"/);
});

test('primary-view keyboard state machine survives 250k transitions and busy gate never admits mutations', async()=>{
  const { PRIMARY_VIEWS, movePrimaryView, viewForFunctionKey, isBusySafeUiAction } = await import('../.test-dist/sandbox/uiNavigation.js');
  let view='exploration';
  const keys=['ArrowLeft','ArrowRight','Home','End','ArrowRight','ArrowRight','ArrowLeft'];
  for(let i=0;i<250000;i++){
    if(i%31===0) view=viewForFunctionKey(`F${(i%5)+1}`)??view;
    else view=movePrimaryView(view,keys[i%keys.length]);
    assert.ok(PRIMARY_VIEWS.includes(view));
  }
  for(const action of ['view','inspect-agent','select-local-entity','select-world-entity','map-scope','a11y-scale','a11y-contrast','a11y-motion']) assert.equal(isBusySafeUiAction(action),true);
  for(const action of ['advance','launch','rescue','direct-camp','wedo-round','conversation','archive-knowledge','research','policy','external','anomaly-use','reset','import']) assert.equal(isBusySafeUiAction(action),false,`mutation escaped busy gate: ${action}`);
});

test('save/import/reset UI transactions serialize destructive persistence and do not erase failure notices on render', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/private async importSave\(file: File\)/);
  assert.match(app,/this\.#busy = true; this\.render\(\);/);
  assert.match(app,/assertImportedSaveProviderCompatible\(next, manifest\)/);
  const safety=await read('src/sandbox/worldMutationSafety.ts');
  assert.match(safety,/Save WorldProvider identity does not match the active provider/);
  assert.match(app,/private async resetSave\(\)/);
  assert.match(app,/window\.confirm\('Delete the current settlement archive\?'\)/);
  assert.match(app,/await this\.repository\.clear\(\); window\.location\.reload\(\)/);
  assert.match(app,/let notice = message \?\? ''/);
  assert.match(app,/this\.render\(\);\n\s+if \(notice\) this\.toast\(notice\)/);
});

test('startup recovery separates corrupt saves, unavailable persistence and provider fallback without silent overwrite', async()=>{
  const main=await read('src/main.ts');
  const storage=await read('src/sandbox/storage.ts');
  const app=await read('src/sandbox/app.ts');
  assert.match(storage,/loadRecoverable\(\)/);
  assert.match(storage,/corrupt-save-quarantined/);
  assert.match(storage,/Put-before-delete in one transaction/);
  assert.match(storage,/navigator\.locks/);
  assert.match(storage,/db\.onversionchange = \(\) => db\.close\(\)/);
  assert.match(storage,/Sandbox save database is blocked by another game window/);
  assert.match(storage,/createVolatileSandboxRepository/);
  assert.match(main,/Start temporary session \(do not modify save slot\)/);
  assert.match(main,/Continue from saved snapshot \(temporary recovery mode\)/);
  assert.match(main,/durable save is protected from degraded-provider writes/);
  assert.match(main,/Provider identity mismatch is not permission to silently discard a valid save/);
  assert.match(main,/mockWorld session: persistence is temporary/);
  assert.match(app,/RECOVERY \/ LINK DEGRADED/);
  assert.match(app,/このセッションを閉じる前にArchiveを書き出してください/);
});

test('multi-tab persistence uses revisioned envelopes so stale tabs cannot overwrite or reset newer saves', async()=>{
  const storage=await read('src/sandbox/storage.ts');
  assert.match(storage,/descendants-save-envelope-v1/);
  assert.match(storage,/durableRevision/);
  assert.match(storage,/assertStorageRevision\(expectedRevision, actualRevision, 'write'\)/);
  assert.match(storage,/assertStorageRevision\(expectedRevision, actualRevision, 'reset'\)/);
  assert.match(storage,/tx\.abort\(\)/);
  assert.match(storage,/Pre-envelope IndexedDB saves are revision\/generation zero/);
  assert.match(storage,/PREVIOUS_STORAGE_KEY/);
  assert.match(storage,/commitGeneration/);
});

test('lifecycle and provider-failure recovery fail closed instead of persisting partial world mutations', async()=>{
  const app=await read('src/sandbox/app.ts');
  const storage=await read('src/sandbox/storage.ts');
  const engine=await read('src/sandbox/engine.ts');
  const main=await read('src/main.ts');
  assert.match(app,/addEventListener\('pagehide'/);
  assert.match(app,/visibilityState === 'hidden'/);
  assert.match(app,/lastCommittedState/);
  assert.match(app,/checkFreshness\(\)/);
  assert.match(app,/別の端末で新しいArchive記録/);
  assert.match(app,/provider-resync-reload/);
  assert.match(app,/WORLD LINKの記録とArchiveの時刻が一致していません/);
  assert.match(app,/resynchronizeProvider/);
  assert.match(storage,/descendants-save-envelope-v3/);
  assert.match(storage,/descendants-save-envelope-v2/);
  assert.match(storage,/stateHash: sandboxStateChecksum/);
  assert.match(storage,/checksum mismatch; interrupted or corrupted write detected/);
  assert.match(storage,/descendants-save-envelope-v1/);
  assert.match(engine,/restoreSandboxState\(state, committed\)/);
  assert.match(engine,/ProviderMutationUncertainError/);
  assert.match(main,/state\.clock\.worldTick !== accepted\.manifest\.currentTick/);
});

test('provider uncertainty offers in-process reconstruction from the last committed snapshot before falling back to reload', async()=>{
  const app=await read('src/sandbox/app.ts');
  const main=await read('src/main.ts');
  assert.match(app,/recoverProvider\?:/);
  assert.match(app,/resynchronizeProvider/);
  assert.match(app,/structuredClone\(this\.#lastCommittedState\)/);
  assert.match(app,/assertProviderAligned\(recovered\.provider, committed\)/);
  assert.match(app,/this\.provider = recovered\.provider/);
  assert.match(app,/WORLD LINKを最後に確認されたArchiveから復旧しました。指令を再開できます。/);
  assert.match(main,/createRealWorldRuntime\(\{ snapshot \}\)/);
  assert.match(main,/new SnapshotWorldProvider\(snapshot\)/);
});

test('F1 exposes a screenshot-verified vertical field cycle without turning guidance into authored quest state', async()=>{
  const app=await read('src/sandbox/app.ts');
  const css=await read('src/styles.css');
  assert.match(app,/FIELD CYCLE \/ OPERATION GUIDE/);
  assert.match(app,/1 TARGET/);
  assert.match(app,/2 PREP/);
  assert.match(app,/3 FIELD/);
  assert.match(app,/4 RETURN/);
  assert.match(app,/5 RECORD/);
  assert.match(app,/Choose a known WORLD destination/);
  assert.match(app,/Prepare and launch the expedition/);
  assert.match(app,/Resolve the active WEDO encounter/);
  assert.match(app,/Turn returned evidence into durable knowledge/);
  assert.doesNotMatch(app,/fieldCycleQuest|questStage|completeQuest/);
  assert.match(css,/generated-inspector \.prep-grid\{grid-template-columns:1fr\}/);
  assert.match(css,/known-map-marker\.world-entity-marker:hover/);
  assert.match(css,/sandbox-shell:has\(\.sandbox-recovery-banner\)/);
});

test('returned field evidence stays reachable through an explicit co-located F3 knowledge-holder viewpoint without transferring control', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/knowledgeEligibleAgents\(\)/);
  assert.match(app,/記録閲覧者 \/ 同席者/);
  assert.match(app,/同席者の携行記録を閲覧しても、指揮権やArchive登録は変更されません。/);
  assert.match(app,/recent.*status==='returned'/s);
  assert.match(app,/const speaker=this\.knowledgeAgent\(\)/);
  assert.match(app,/const author=this\.knowledgeAgent\(\)/);
  assert.doesNotMatch(app,/this\.state\.settlement\.leaderId\s*=\s*this\.#knowledgeAgentId/);
});


test('returned physical samples stay visibly inspectable through a co-located F4 inventory-holder viewpoint without transferring control', async() => {
  const app = await read('src/sandbox/app.ts');
  assert.match(app, /data-action=\"inventory-agent\"/);
  assert.match(app, /Inspecting another co-located person’s carried items does not transfer control or ownership/);
  assert.match(app, /physical-sample/);
  assert.match(app, /inventoryAgent\(\)/);
  const css = await read('src/styles.css');
  assert.match(css, /sandbox-panel\.inventory-grid>h3\{grid-column:1\/-1\}/);
  assert.match(css, /a11y-scale-150 \.sandbox-panel\.inventory-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
});

test('known external-society primary commands precede secondary relationship/debrief detail', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/Known relationship \/ settlement action<\/strong><div class="external-action-buttons">/);
  assert.match(app,/external-action-buttons.*external-relation-readout.*LATEST VISIBLE OUTCOME/s);
});

test('visual QA can deterministically enter the real WEDO simulation without exposing a production debug control', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/visualQaEncounterControlsEnabled/);
  assert.match(app,/this\.#providerMode === 'mock-diagnostic' && this\.#persistenceMode !== 'durable'/);
  assert.match(app,/data-action="qa-trigger-encounter"/);
  assert.match(app,/WEDO接触を開始/);
  assert.match(app,/createEncounter\(this\.state,expedition,doctrine\.encounterInstruction,2\)/);
  assert.match(app,/この端末ではWEDO接触誘発コマンドを使用できません。/);
});

test('active WEDO keeps canonical primary controls and live encounter HP ahead of expedition detail', async()=>{
  const app=await read('src/sandbox/app.ts');
  const expedition=await read('src/sandbox/expeditionSimulation.ts');
  const css=await read('src/styles.css');
  assert.match(app,/activeEncounter\.actors\.filter/);
  assert.match(app,/ROUND INTERVAL · 10 min/);
  assert.match(app,/class="wedo-control-row"/);
  assert.match(app,/Resolve next WEDO round · 10 min/);
  assert.match(app,/activeEncounter\?`\$\{wedo\}\$\{fieldControlMeta\}\$\{expeditionDetail\}`/);
  assert.match(app,/LAST WEDO \/ RESOLVED/);
  assert.match(app,/activeEncounter\?`\$\{wedo\}\$\{fieldControlMeta\}\$\{expeditionDetail\}`:`\$\{fieldControlMeta\}\$\{wedoDebrief\}\$\{expeditionDetail\}`/);
  assert.match(app,/field-wedo-summary/);
  assert.match(app,/settlement visibility still follows return \/ communication \/ archive routes/);
  assert.match(expedition,/title: 'Encounter resolved'/);
  assert.match(css,/Direct WEDO must remain operable inside the initial F1 viewport/);
  assert.match(css,/a11y-contrast \.known-map-marker\.world-entity-marker/);
});


test('generated F1 inspector preserves scroll across same-context mutations but resets when context identity changes', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/explorationInspectorScrollKey/);
  assert.match(app,/data-scroll-key="\$\{esc\(this\.explorationInspectorScrollKey\(\)\)\}"/);
  assert.match(app,/previousInspectorScroll/);
  assert.match(app,/nextInspector\?\.dataset\.scrollKey === previousInspectorScroll\.key/);
  assert.match(app,/nextInspector\.scrollTop = previousInspectorScroll\.top/);
  assert.match(app,/`world:\$\{this\.#selectedWorldEntityId \|\| 'none'\}`/);
  assert.match(app,/`local:\$\{this\.#selectedLocalEntityId \|\| 'none'\}`/);
  assert.match(app,/`wedo:\$\{activeEncounterId\}`/);
});


test('main direct-play content preserves scroll across same-context rerenders and resets on subject/view changes', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/mainContentScrollKey/);
  assert.match(app,/data-scroll-key="\$\{esc\(this\.mainContentScrollKey\(\)\)\}"/);
  assert.match(app,/`body:\$\{this\.#inspectedAgentId \|\| this\.state\.settlement\.leaderId\}`/);
  assert.match(app,/`knowledge:\$\{this\.#knowledgeAgentId \|\| this\.controlledAgent\(\)\?\.id \|\| this\.state\.settlement\.leaderId\}`/);
  assert.match(app,/`inventory:\$\{this\.#inventoryAgentId \|\| this\.controlledAgent\(\)\?\.id \|\| this\.state\.settlement\.leaderId\}`/);
  assert.match(app,/previousContentScroll/);
  assert.match(app,/nextContent\?\.dataset\.scrollKey === previousContentScroll\.key/);
  assert.match(app,/nextContent\.scrollTop = previousContentScroll\.top/);
});


test('injury recovery is visible and actionable across F1 crew preparation and F2 clinic care', async()=>{
  const app=await read('src/sandbox/app.ts');
  const expedition=await read('src/sandbox/expeditionSimulation.ts');
  const settlement=await read('src/sandbox/settlementSimulation.ts');
  const css=await read('src/styles.css');
  assert.match(app,/EXPEDITION FITNESS/);
  assert.match(app,/RECOVERING \/ NOT FIT TO DEPART/);
  assert.match(app,/Request clinic care · 60 min/);
  assert.match(app,/data-action="clinic-care"/);
  assert.match(app,/expeditionMemberReadiness/);
  assert.match(app,/readiness\.ready\?'':'unfit'/);
  assert.match(app,/HP \$\{agent\.health\.toFixed\(0\)\} · fat \$\{agent\.fatigue\.toFixed\(0\)\}/);
  assert.match(expedition,/minimumHealth = Math\.min\(90, Math\.max\(60, Math\.ceil\(doctrine\.retreatHealth \+ 10\)\)\)/);
  assert.match(expedition,/is not fit to depart/);
  assert.match(settlement,/agent\.health < 55/);
  assert.match(settlement,/reserveDirectActivity\(state, \[patient\.id, medic\.id\], 'clinic'/);
  assert.match(css,/\.crew-picker label\.unfit/);
  assert.match(app,/class="crew-name"/);
  assert.match(css,/grid-template-columns:16px minmax\(0,1fr\)/);
  assert.match(css,/\.recovery-readiness/);
});


test('assembly UI exposes one deliberation per labor topic per canonical day instead of repeat-vote spam', async()=>{
  const app=await read('src/sandbox/app.ts');
  const politics=await read('src/sandbox/politicalSimulation.ts');
  const css=await read('src/styles.css');
  assert.match(app,/laborPriorityProposalAvailability/);
  assert.match(app,/voted today/);
  assert.match(app,/availability\.allowed\?'':'disabled'/);
  assert.match(politics,/already considered by the assembly on Day/);
  assert.match(politics,/entry\.task === task && entry\.day === state\.clock\.day/);
  assert.match(css,/policy-priority-row\.considered-today/);
});


test('assembly UI surfaces persistent coalition continuity from prior votes', async()=>{
  const app=await read('src/sandbox/app.ts');
  const politics=await read('src/sandbox/politicalSimulation.ts');
  assert.match(app,/political memory · \$\{repeatedSupport\} repeated support/);
  assert.match(app,/switched side/);
  assert.match(politics,/assembly:preference:\$\{task\}/);
  assert.match(politics,/politicalMemory \* 0\.5/);
  assert.match(politics,/kind: 'social'/);
});

test('external society primary actions surface cooldown state instead of allowing relationship-value spam', async()=>{
  const app=await read('src/sandbox/app.ts');
  const external=await read('src/sandbox/externalActions.ts');
  const css=await read('src/styles.css');
  assert.match(app,/externalActionAvailability/);
  assert.match(app,/`wait \$\{waitHours\}h`/);
  assert.match(app,/availability\.allowed\?'':'disabled'/);
  assert.match(external,/trade: 360/);
  assert.match(external,/diplomacy: 720/);
  assert.match(external,/migration: 1440/);
  assert.match(external,/conflict: 360/);
  assert.match(external,/needs \$\{remainingMinutes\} more canonical minute/);
  assert.match(css,/external-action-buttons button:disabled/);
});


test('F4 settlement stock keeps readable resource/value/action cells at standard scale', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.sandbox-panel\.inventory-grid\{grid-template-columns:repeat\(auto-fit,minmax\(185px,1fr\)\)\}/);
  assert.match(css, /a11y-scale-150 \.sandbox-panel\.inventory-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
});

test('F2 distinguishes provider-confirmed migrant identity from lived migrant fallback without implying provider household migration', async()=>{
  const app=await read('src/sandbox/app.ts');
  const migration=await read('src/sandbox/migrationSimulation.ts');
  assert.match(app,/ORIGIN ARCHIVE \/ MIGRANT/);
  assert.match(app,/この個人の移住確認だけでは元世帯全体の移動は確定しません/);
  assert.match(app,/origin migrant/);
  assert.match(app,/local migrant/);
  assert.match(app,/household <b>\$\{authorityLabel\(authority\?\.household\)\}/);
  assert.match(migration,/migration-specific payload fields are strong enough to transfer provider identity authority/);
  assert.doesNotMatch(migration,/ids\.push\(\.\.\.event\.actorIds,\.\.\.event\.targetIds/);
});

test('QA8 external conflict UI surfaces provider-observed consequences and displaced status without inventing hidden facts', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/LATEST OBSERVED CONSEQUENCE/);
  assert.match(app,/recentObservedConflict\.injuredIndividualIds/);
  assert.match(app,/recentObservedConflict\.displacedIndividualIds/);
  assert.match(app,/recentObservedConflict\.affectedRouteEntityIds/);
  assert.match(app,/stock loss/);
  assert.match(app,/displaced \/ whereabouts unknown/);
});

test('QA9 displacement recovery UI keeps returned and unresolved residents simultaneously visible from provider evidence', async()=>{
  const app=await read('src/sandbox/app.ts');
  const situation=await read('src/sandbox/situationSynthesis.ts');
  assert.match(app,/returned-to-settlement local ID/);
  assert.match(app,/LATEST OBSERVED CONSEQUENCE/);
  assert.match(app,/recentObservedConflict\.kind === 'recovery' \? \[\] : \[`severity/);
  assert.match(situation,/Residents remain displaced \/ whereabouts unknown/);
  assert.match(situation,/Provider-observed returns are re-entering settlement life/);
  assert.match(situation,/Time passage alone does not establish a return/);
  assert.match(situation,/explicit observed return and now rejoin ordinary local labor, food, water and care systems/);
});


test('QA11 household displacement UI distinguishes explicit household evidence from individual displacement', async()=>{
  const app=await read('src/sandbox/app.ts');
  const situation=await read('src/sandbox/situationSynthesis.ts');
  const conflict=await read('src/sandbox/externalConflictSimulation.ts');
  assert.match(app,/displaced household ID/);
  assert.match(app,/returned household ID/);
  assert.match(situation,/Provider-confirmed households remain displaced/);
  assert.match(situation,/Individual displacement evidence alone never creates this household state/);
  assert.match(situation,/Provider-confirmed households have returned/);
  assert.match(conflict,/Individual evidence remains individual evidence/);
  assert.match(conflict,/provider explicitly names the household ID/);
  assert.match(conflict,/Members in another known physical state were not teleported/);
});

test('QA10 expedition preparation exposes direct-vs-known-route choice and provider-observed route evidence without treating silence as safety', async()=>{
  const app=await read('src/sandbox/app.ts');
  const conflict=await read('src/sandbox/externalConflictSimulation.ts');
  const expedition=await read('src/sandbox/expeditionSimulation.ts');
  const types=await read('src/sandbox/types.ts');
  const storage=await read('src/sandbox/storage.ts');
  assert.match(app,/#prepTargetEntityId/);
  assert.match(app,/#prepRouteEntityId/);
  assert.match(app,/data-action="prep-route"/);
  assert.match(app,/direct \/ no waypoint/);
  assert.match(app,/ROUTE CHOICE ·/);
  assert.match(app,/Selected route has recorded disruption severity/);
  assert.match(app,/Absence of observed disruption is not proof of safety/);
  assert.match(app,/routeEntityId:selectedRoute\.id/);
  assert.match(conflict,/expedition\.routeEntityId/);
  assert.match(expedition,/routeWaypoint/);
  assert.match(types,/routeEntityId\?: string/);
  assert.match(types,/routeWaypoint\?: SpatialRef/);
  assert.match(storage,/routeWaypointReached/);
});

test('QA12 route preparation exposes provider-visible topology alternatives without claiming unseen safe routes', async()=>{
  const app=await read('src/sandbox/app.ts');
  const planning=await read('src/sandbox/routePlanning.ts');
  const expedition=await read('src/sandbox/expeditionSimulation.ts');
  const conflict=await read('src/sandbox/externalConflictSimulation.ts');
  const types=await read('src/sandbox/types.ts');
  const storage=await read('src/sandbox/storage.ts');
  assert.match(app,/providerVisibleRouteAlternatives/);
  assert.match(app,/RECORDED ROUTE/);
  assert.match(app,/direct \/ no waypoint \/ no known topology/);
  assert.match(app,/does not infer an unseen safe path/);
  assert.match(app,/stretchFromShortest|overlapWithShortest/);
  assert.match(planning,/route-link/);
  assert.match(planning,/relation\.kind === 'connects'/);
  assert.match(planning,/kShortestLooplessPaths/);
  assert.match(planning,/No geometric proximity edge is invented/);
  assert.match(expedition,/routePlan/);
  assert.match(conflict,/routePlan\?\.evidenceIds/);
  assert.match(types,/ExpeditionRoutePlan/);
  assert.match(storage,/routePlan edge\/node cardinality/);
});

test('QA13 field UI exposes dynamic provider-route state and never promises an unseen detour', async()=>{
  const app=await read('src/sandbox/app.ts');
  const expedition=await read('src/sandbox/expeditionSimulation.ts');
  const planning=await read('src/sandbox/routePlanning.ts');
  assert.match(app,/CHARTED ROUTE/);
  assert.match(app,/replans/);
  assert.match(app,/No alternate route is recorded/);
  assert.match(expedition,/Provider topology route blocked/);
  assert.match(expedition,/stopped before traversing invalidated topology/);
  assert.match(planning,/Missing relations remain epistemically unknown/);
  assert.match(planning,/providerRelationExplicitPassability/);
});


test('QA14 field UI requires explicit blocked-route decisions and surfaces provider-bounded camp exposure', async()=>{
  const app=await read('src/sandbox/app.ts');
  const field=await read('src/sandbox/fieldDecisionSimulation.ts');
  const expedition=await read('src/sandbox/expeditionSimulation.ts');
  const storage=await read('src/sandbox/storage.ts');
  assert.match(app,/data-action="field-wait"/);
  assert.match(app,/data-action="field-retry"/);
  assert.match(app,/data-action="field-return"/);
  assert.match(app,/FIELD DECISION/);
  assert.match(app,/observed exposure risk/);
  assert.match(app,/Time alone does not reopen the route/);
  assert.match(field,/issueBlockedFieldDecision/);
  assert.match(field,/Proximity, season, or remembered weather alone never create exposure risk/);
  assert.match(expedition,/blockedRetryRequested/);
  assert.match(expedition,/Once blocked, route planning is retried only by an explicit retry-replan field decision/);
  assert.match(storage,/fieldDecision/);
  assert.match(storage,/fieldExposure/);
  assert.match(storage,/off-network-bearing/);
});

test('QA15 field UI exposes physical off-network return and communication-bounded rendezvous without hidden tracking', async()=>{
  const app=await read('src/sandbox/app.ts');
  const fieldReturn=await read('src/sandbox/fieldReturnSimulation.ts');
  const rendezvous=await read('src/sandbox/rendezvousSimulation.ts');
  const field=await read('src/sandbox/fieldDecisionSimulation.ts');
  const storage=await read('src/sandbox/storage.ts');
  assert.match(app,/OFF-NETWORK RETURN/);
  assert.match(app,/dead-reckoning uncertainty/);
  assert.match(app,/data-action="field-rendezvous"/);
  assert.match(app,/Exact field position remains unknown until a transmission is received/);
  assert.match(app,/not a live position signal/);
  assert.match(fieldReturn,/terrainDifficulty/);
  assert.match(fieldReturn,/navigationAnchor/);
  assert.match(fieldReturn,/uncertaintyKm/);
  assert.match(rendezvous,/pending-link/);
  assert.match(rendezvous,/position at transmission time/);
  assert.match(field,/field-exposure-burden/);
  assert.match(storage,/returnTravel/);
  assert.match(storage,/rendezvousRequest/);
});

test('ZONE-PDA adopted mainline gives F2-F5 dedicated data surfaces and a map-to-expedition launch path', async()=>{
  const app=await read('src/sandbox/app.ts');
  const css=await read('src/styles.css');
  for(const method of ['pdaBodyPanel','pdaKnowledgePanel','pdaInventoryPanel','pdaChroniclePanel']) assert.match(app,new RegExp(`private ${method}\\(`));
  assert.match(app,/DESCENDANTS \/ PDA DATA SURFACE/);
  assert.match(app,/PERSON \/ BODY RECORD/);
  assert.match(app,/EPISTEMIC TERMINAL/);
  assert.match(app,/PHYSICAL ACCESS \/ INVENTORY/);
  assert.match(app,/VISIBLE HISTORY \/ EVENT LOG/);
  assert.match(app,/if \(action==='set-prep-target'\)[^\n]+#pdaTaskPanel='expedition'[^\n]+#pdaTab='task'/);
  assert.match(app,/data-action="launch" class="launch"/);
  assert.match(app,/this\.#pdaTaskPanel='overview'; this\.#pdaTab='task'/);
  assert.match(css,/\.desc-pda-data-panel/);
  assert.match(css,/\.desc-pda-chronicle-ledger/);
});


test('I1-D2 WORLD read-switch wiring remains feature-flagged and fail-closed behind the existing map seam', async()=>{
  const app=await read('src/sandbox/app.ts');
  const projection=await read('src/sandbox/knowledgeGraphProjection.ts');
  assert.match(app,/selectWorldGraphReadModel/);
  assert.match(app,/const read = selectWorldGraphReadModel\(this\.state, controlled\.id, this\.#worldProjection\)/);
  assert.match(app,/return read\.entities/);
  assert.match(app,/data-action="set-prep-target" data-entity-id="\$\{esc\(selectedWorld\.id\)\}"/);
  assert.match(app,/data-action="select-world-entity" data-entity-id="\$\{esc\(entry\.id\)\}"/);
  assert.match(projection,/descendants\.i1d\.world-read-v2\.v1/);
  assert.match(projection,/projection mismatch; using legacy WORLD authority/);
  assert.match(projection,/provider entity identity\/order mismatch; using legacy WORLD authority/);
  assert.match(projection,/source: 'shadow'/);
});

test('I2-I F1 response controls remain explicit opt-in and do not replace the safe legacy default', async()=>{
  const app=await read('src/sandbox/app.ts');
  const incidents=await read('src/sandbox/incidentService.ts');
  assert.match(app,/緊急対応回線:/);
  assert.match(app,/data-action="incident-adapter-toggle"/);
  assert.match(app,/CLOSED/);
  assert.match(app,/I2_F1_INCIDENT_STORAGE_KEY/);
  assert.match(incidents,/return typeof globalThis\.localStorage !== 'undefined' && globalThis\.localStorage\.getItem\(I2_F1_INCIDENT_STORAGE_KEY\) === '1'/);
  assert.match(app,/read\.source !== 'incident'/);
});

test('I2-I F1 response write controls route only through bounded I2-C/I2-G seams', async()=>{
  const app=await read('src/sandbox/app.ts');
  for(const action of ['incident-response-member','incident-assign','incident-dispatch','incident-stand-down','incident-resource-use']) assert.match(app,new RegExp(`data-action="${action}"`));
  assert.match(app,/assignIncidentResponseTeam\(this\.state,incidentId,\[\.\.\.this\.#incidentResponderDraftIds\],field\)/);
  assert.match(app,/dispatchIncidentResponseTeam\(this\.state,button\.dataset\.teamId/);
  assert.match(app,/standDownIncidentResponseTeam\(this\.state,button\.dataset\.teamId/);
  assert.match(app,/applyIncidentResponseEvidenceResourceUse\(this\.state,incidentId/);
  assert.doesNotMatch(app,/resolvePersistedIncident\(this\.state/);
});

test('I2-I F1 status surface reads structured operation resource evidence and debrief facts without causal prose', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/incidentResponseOperations\(this\.state, incident\.id, field\)/);
  assert.match(app,/incidentResponseResourceReservations\(this\.state, incident\.id, field\)/);
  assert.match(app,/incidentResponseEvidenceResourceUses\(this\.state, incident\.id, field\)/);
  assert.match(app,/incidentResponseDebriefs\(this\.state, incident\.id, field\)/);
  assert.match(app,/Visibility loss or operation completion alone does not resolve this incident/);
  assert.match(app,/operator confirmation never asserts causal success/);
  assert.match(app,/未確認の原因や結果は確定記録にしません/);
});

test('I2-I response panel preserves bounded ZONE_PDA layout with responsive collapse', async()=>{
  const css=await read('src/styles.css');
  assert.match(css,/\.desc-pda-response-panel/);
  assert.match(css,/grid-template-columns:minmax\(160px,.9fr\) minmax\(220px,1.15fr\) minmax\(220px,1.25fr\)/);
  assert.match(css,/@media\(max-width:900px\)\{\.desc-pda-response-grid\{grid-template-columns:1fr\}/);
});


test('I2-J F1 incident rows expose selectable observer-safe focus without persisting a new authority', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/data-action="incident-focus"/);
  assert.match(app,/data-incident-id="\$\{esc\(signal\.id\)\}"/);
  assert.match(app,/role="option" aria-selected="\$\{selected\}"/);
  assert.match(app,/#selectedIncidentId = ''/);
  assert.match(app,/read\.incidents\.find\(\(incident\)=>incident\.id===this\.#selectedIncidentId\) \?\? read\.incidents\[0\]/);
  assert.match(app,/Selected Incident is no longer observer-visible/);
  assert.doesNotMatch(app,/selectedIncidentId:\s*this\.#selectedIncidentId/);
});

test('I2-J incident focus supports bounded keyboard listbox navigation', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/\['ArrowUp','ArrowDown','Home','End'\]\.includes\(event\.key\)/);
  assert.match(app,/data-incident-index="\$\{index\}"/);
  assert.match(app,/#focusAfterRender=`\[data-action="incident-focus"\]\[data-incident-index="\$\{next\}"\]`/);
  assert.match(app,/#incidentResponderDraftIds\.clear\(\)/);
});

test('I2-J debrief history navigation remains structured-fact only', async()=>{
  const app=await read('src/sandbox/app.ts');
  for(const action of ['incident-debrief-select','incident-debrief-prev','incident-debrief-next']) assert.match(app,new RegExp(`data-action="${action}"`));
  assert.match(app,/DEBRIEF FACT \$\{debriefIndex\+1\}\/\$\{debriefs\.length\}/);
  assert.match(app,/selectedDebrief\.chronology\.startedAt/);
  assert.match(app,/selectedDebrief\.observations\.map/);
  assert.match(app,/selectedDebrief\.positiveEvidence\.map/);
  assert.match(app,/selectedDebrief\.evidenceResourceUses\.map/);
  assert.doesNotMatch(app,/debrief.*causalAssessment/i);
});

test('I2-J compact and accessibility rules provide focus visibility and touch-sized controls', async()=>{
  const css=await read('src/styles.css');
  assert.match(css,/\.desc-pda-incident-focus:focus-visible\{outline:2px solid #e1d362/);
  assert.match(css,/\.desc-pda-response-debrief-detail/);
  assert.match(css,/@media\(max-width:900px\).*min-height:32px/s);
  assert.match(css,/@media\(max-width:620px\).*grid-template-columns:1fr/s);
  assert.match(css,/\.desc-pda-hardware\.a11y-contrast \.desc-pda-incident-focus\[aria-selected="true"\]/);
});

test('I2-J selected incident feeds both task detail and response panel from the same read model', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/const selectedIncident = this\.selectedF1Incident\(incidentRead\)/);
  assert.match(app,/situations\.find\(\(entry\)=>entry\.id===selectedIncident\.id\)/);
  assert.match(app,/this\.pdaIncidentResponsePanel\(incidentRead\)/);
  assert.match(app,/対応記録は選択中の事案と現地報告のみ/);
});


test('I2-K debrief filters are bounded presentation-only fact selectors', async()=>{
  const app=await read('src/sandbox/app.ts');
  for(const filter of ['all','completed','aborted','evidence','resource']) assert.match(app,new RegExp(`'${filter}'`));
  assert.match(app,/data-action="incident-debrief-filter"/);
  assert.match(app,/entry\.terminalPhase==='completed'/);
  assert.match(app,/entry\.terminalPhase==='aborted'/);
  assert.match(app,/entry\.positiveEvidence\.length>0/);
  assert.match(app,/entry\.evidenceResourceUses\.length>0/);
  assert.doesNotMatch(app,/incidentDebriefFilter:\s*this\.#incidentDebriefFilter/);
});

test('I2-K response density is session-local and never becomes save authority', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/#incidentResponseDensity: IncidentResponseDensity = 'standard'/);
  assert.match(app,/data-action="incident-density-toggle"/);
  assert.match(app,/this\.#incidentResponseDensity==='compact'\?'standard':'compact'/);
  assert.match(app,/DENSITY: COMPACT/);
  assert.doesNotMatch(app,/incidentResponseDensity:\s*this\.#incidentResponseDensity/);
});

test('I2-K status strip reports bounded response fact counts without causal assessment', async()=>{
  const app=await read('src/sandbox/app.ts');
  assert.match(app,/desc-pda-response-status-strip/);
  assert.match(app,/dispatched<\/span>/);
  assert.match(app,/in progress<\/span>/);
  assert.match(app,/evidence facts<\/span>/);
  assert.match(app,/resource-use facts<\/span>/);
  assert.match(app,/const statusStrip = `<div class=\"desc-pda-response-status-strip\"/);
});

test('I2-K compact density and filter controls remain touch and contrast accessible', async()=>{
  const css=await read('src/styles.css');
  assert.match(css,/\.desc-pda-response-toolbar/);
  assert.match(css,/\.desc-pda-response-panel\.is-compact/);
  assert.match(css,/\.desc-pda-response-status-strip/);
  assert.match(css,/@media\(max-width:620px\).*min-height:36px/s);
  assert.match(css,/a11y-contrast \.desc-pda-response-toolbar button/);
});

test('I2-K release gate remains structurally default-off until explicit visual acceptance exists', async()=>{
  const service=await read('src/sandbox/incidentService.ts');
  const app=await read('src/sandbox/app.ts');
  const gate=await read('tools/audit-i2k-incident-adapter-release-gate.mjs');
  assert.match(service,/getItem\(I2_F1_INCIDENT_STORAGE_KEY\) === '1'/);
  assert.match(service,/Feature-flagged F1 adapter\. Default OFF/);
  assert.match(app,/CLOSED/);
  assert.match(gate,/SAFE_BLOCKED/);
  assert.match(gate,/I2K_HUMAN_VISUAL_ACCEPTANCE\.json/);
  assert.match(gate,/promotionAllowed: false/);
});

test('Electron diagnostic records Daily Command Center and compact-overflow evidence', async()=>{
  const main=await read('electron/main.cjs');
  const runner=await read('tools/run-electron-path-e2e.mjs');
  for(const token of ['commandCenter','desc-daily-priority','desc-daily-resource-summary','desc-daily-readiness','execute-plan','daily-command-normal','daily-command-1280x720','compactContentBounds','compactNoHorizontalOverflow']) {
    assert.ok(main.includes(token), `missing Electron Daily Command diagnostic token: ${token}`);
  }
  for(const token of ['commandCenter?.priorities','commandCenter?.resourceCards','commandCenter?.readiness','commandCenter?.executePresent','compactNoHorizontalOverflow']) {
    assert.ok(runner.includes(token), `missing Electron runner assertion token: ${token}`);
  }
});
