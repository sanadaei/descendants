import { readFile, writeFile } from 'node:fs/promises';
const packFiles=['comparative-motif-foundation.json','comparative-motif-expansion.json'];
const motifs=[]; const relations=[];
for(const file of packFiles){const j=JSON.parse(await readFile(new URL(`../setting-packs/descendants/content-packs/${file}`,import.meta.url),'utf8')); motifs.push(...(j.data?.loreCorpus?.motifs??[])); relations.push(...(j.data?.loreCorpus?.motifRelations??[]));}
const stop=new Set(['the','a','an','of','to','and','or','as','in','by','from','with']);
const tokens=(s)=>s.toLowerCase().split(/[^a-z0-9]+/g).filter(x=>x.length>2&&!stop.has(x));
const roleRules=[
 [/threshold|boundary|gate|crossing|passage/,['boundary','transition']], [/forbidden|taboo|prohibition/,['constraint','norm']], [/journey|road|route|path|pilgrimage/,['movement','transition']], [/gift|exchange|bargain|loan|debt|offering/,['reciprocity','obligation']], [/name|identity|double|lineage|ancestor/,['identity','continuity']], [/transform|change|assembled|divided|wound|shadow/,['state-change','embodiment']], [/death|grave|corpse|burial|psychopomp/,['mortality','afterlife']], [/heal|disease|remedy|diagnosis/,['affliction','restoration']], [/message|signal|speech|record|testimony|memory|dream/,['information','epistemic']], [/place|landscape|road|river|mountain|well|spring/,['spatial-anchor','environment']], [/ritual|ceremony|oath|sacrifice|purification/,['ritual-action','social-regulation']], [/animal|spirit|ancestor|weather|sun|wind|storm/,['nonhuman-agent','agency']]
];
const facetRules=[
 [/threshold|boundary|gate|route|road|place|landscape/,['space']], [/time|season|dawn|night|age/,['temporality']], [/name|identity|lineage|ancestor|kinship/,['identity']], [/body|wound|corpse|disease|heal/,['embodiment']], [/speech|message|record|testimony|knowledge|dream|signal/,['information']], [/gift|exchange|debt|bargain|offering/,['exchange']], [/taboo|forbidden|oath|ritual|ceremony/,['norms']], [/storm|river|water|fire|flood|weather/,['environment']]
];
const relMap=new Map();
for(const r of relations){if(!['substitution','functional-equivalence','neighborhood','contrast','opposition'].includes(r.relationType)) continue; for(const [a,b] of [[r.sourceMotifId,r.targetMotifId],[r.targetMotifId,r.sourceMotifId]]){if(!relMap.has(a))relMap.set(a,[]); relMap.get(a).push({id:b,type:r.relationType,weight:r.weight});}}
const proposals=motifs.map(m=>{
 const text=`${m.family} ${m.label} ${(m.triggerTags??[]).join(' ')}`; const roles=new Set(); const facets=new Set();
 for(const [re,vals] of roleRules) if(re.test(text.toLowerCase())) vals.forEach(v=>roles.add(v));
 for(const [re,vals] of facetRules) if(re.test(text.toLowerCase())) vals.forEach(v=>facets.add(v));
 if(!roles.size) roles.add('narrative-function'); if(!facets.size) facets.add('social-meaning');
 const semantic=tokens(m.label).filter(t=>!tokens(m.family).includes(t));
 const motifeme=`${m.family}: ${semantic.join(' ')||m.label.toLowerCase()}`;
 const linked=(relMap.get(m.id)??[]).sort((a,b)=>b.weight-a.weight||a.id.localeCompare(b.id)).slice(0,4).map(x=>x.id);
 return {motifId:m.id,currentStructuralReviewStatus:m.structuralReviewStatus??'unreviewed',proposedMotifeme:motifeme,proposedAllomotifMotifIds:linked,proposedStructuralRoles:[...roles].sort(),proposedOntologyFacets:[...facets].sort(),proposalConfidence:Math.min(0.85,0.45+Math.min(0.2,semantic.length*0.05)+Math.min(0.2,linked.length*0.05)),reviewStatus:'heuristic-proposal-not-runtime-authoritative'};
});
const out={generatedAt:'2026-09-08',method:'lexical-structural proposal generator; proposals require curator review before promotion to structuralReviewStatus=curated',proposalCount:proposals.length,alreadyCuratedCount:motifs.filter(m=>m.structuralReviewStatus==='curated').length,proposals};
await writeFile(new URL('../research/lore-materials/MOTIF_STRUCTURE_PROPOSALS_v6.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({proposalCount:out.proposalCount,alreadyCuratedCount:out.alreadyCuratedCount},null,2));
