import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { WorldgenEngine, parseWorldRecipe, validateSnapshotConformance, snapshotDigest } from '../dist/index.js';

const recipeText = await readFile(new URL('../setting-packs/descendants/default.recipe.json', import.meta.url), 'utf8');
const baseRecipe = parseWorldRecipe(recipeText);
const clone = (value) => JSON.parse(JSON.stringify(value));
const cases = [
  { id:'long-runtime', seed:4701, continents:3, regions:6, settlements:2, days:180, queries:36, localExports:5 },
  { id:'large-stream', seed:5101, continents:5, regions:10, settlements:3, days:30, queries:48, localExports:4 },
  { id:'stream-churn', seed:4901, continents:4, regions:8, settlements:3, days:75, queries:96, localExports:8 },
  { id:'medium-a', seed:4101, continents:4, regions:8, settlements:3, days:60, queries:40, localExports:5 },
  { id:'medium-b', seed:4102, continents:4, regions:8, settlements:3, days:60, queries:40, localExports:5 },
  { id:'small-a', seed:3101, continents:2, regions:4, settlements:2, days:60, queries:28, localExports:4 },
  { id:'small-b', seed:3102, continents:2, regions:4, settlements:2, days:60, queries:28, localExports:4 },
];
const requestedCaseIds = new Set((process.env.WORLDGEN_MATRIX_CASES ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const selectedCases = requestedCaseIds.size ? cases.filter((spec) => requestedCaseIds.has(spec.id)) : cases;
const results=[];
for (const spec of selectedCases) {
  console.log(`[matrix] start ${spec.id}`);
  const recipe=clone(baseRecipe); recipe.id=`release-matrix-${spec.id}`; recipe.seed=spec.seed; recipe.geometry.continentCount={mode:'fixed',value:spec.continents};
  const geography=recipe.modules.find((m)=>m.id==='geography'); geography.config={...geography.config,regionsPerContinent:spec.regions,gridWidth:Math.max(28,spec.continents*18),gridHeight:Math.max(18,spec.continents*11)};
  const population=recipe.modules.find((m)=>m.id==='population'); population.config={...population.config,settlementsPerRegion:spec.settlements,basePopulation:2400,routeNeighbors:3};
  const rssBefore=process.memoryUsage().rss; const t0=performance.now(); const world=await new WorldgenEngine().generate(recipe); const generatedMs=performance.now()-t0;
  const settlements=world.snapshot.entities.filter((e)=>e.kind==='settlement'&&e.spatial&&e.endedTick===undefined); const q0=performance.now(); let candidateSum=0; let queryCount=0; let collapseCount=0; let localExportCount=0; let localExportErrors=0;
  for (let i=0;i<spec.queries && settlements.length;i+=1) {
    const s=settlements[(i*17)%settlements.length]; const query={center:s.spatial,radiusKm:10+(i%4)*5,requestedDetailRank:i%3===0?0:2};
    const projection=await world.queryArea(query); candidateSum+=Number(projection.aggregates.streaming?.candidateEntityCount??0); queryCount+=1;
    if (spec.localExports>0 && i % Math.max(1,Math.floor(spec.queries/spec.localExports))===0 && localExportCount<spec.localExports) { const local=await world.exportAreaSnapshot(query); localExportErrors+=validateSnapshotConformance(local).length; localExportCount+=1; }
    if(i%2===0) collapseCount+=world.collapseMaterializedDetail();
  }
  const queryMs=performance.now()-q0; const a0=performance.now(); await world.advance({toTick:world.snapshot.manifest.currentTick+recipe.clock.ticksPerDay*spec.days}); const advanceMs=performance.now()-a0;
  const snapshot=await world.exportSnapshot(); const settlementTotal=snapshot.entities.filter((e)=>e.kind==='settlement').reduce((n,e)=>n+Math.max(0,Number(e.components.population??0)),0); const cohortTotal=snapshot.entities.filter((e)=>e.kind==='population-cohort').reduce((n,e)=>n+Math.max(0,Number(e.components.count??0)),0);
  const resourceBounds=snapshot.entities.filter((e)=>e.kind==='ecological-resource').every((e)=>Number(e.components.currentStock)>=-1e-9&&Number(e.components.currentStock)<=Number(e.components.carryingStock)+1e-9);
  const errors=validateSnapshotConformance(snapshot); const rssAfter=process.memoryUsage().rss;
  results.push({ ...spec, entities:snapshot.entities.length, events:snapshot.events.length, knowledge:snapshot.knowledge.length, digest:snapshotDigest(snapshot), generatedMs, queryMs, advanceMs, totalMs:performance.now()-t0, meanQueryCandidates:queryCount?candidateSum/queryCount:0, collapseCount, localExportCount, localExportErrors, populationConservationError:cohortTotal-settlementTotal, resourceBounds, conformanceErrors:errors, rssBefore, rssAfter, rssDelta:rssAfter-rssBefore, pass:errors.length===0&&localExportErrors===0&&cohortTotal===settlementTotal&&resourceBounds });
  console.log(`[matrix] done ${spec.id}: ${Math.round(performance.now()-t0)} ms`);
  if (typeof global.gc === 'function') global.gc();
  const cooldownMs = Number(process.env.WORLDGEN_MATRIX_COOLDOWN_MS ?? 1500);
  if (cooldownMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, cooldownMs));
}
const report={generatedAt:new Date().toISOString(),engineVersion:(await import('../dist/version.js')).WORLDGEN_ENGINE_VERSION,caseCount:results.length,passed:results.filter((r)=>r.pass).length,failed:results.filter((r)=>!r.pass).length,results};
const out=process.argv[2]??'../integration-artifacts/worldgen/RELEASE_MATRIX_v6.json'; await writeFile(resolve(out),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2)); process.exit(report.failed ? 1 : 0);
