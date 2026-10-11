import { scopedRandom } from './rng.js';
import type { WorldEntity } from '../worldbridge/contract.js';
import type { SandboxGameState } from './types.js';

/** Neral v1: a naming language, not a conversation grammar. CV stems; suffixes allow final n/r/l/s and unlike-vowel hiatus. */
export const NAMING_LANGUAGE = {
  id: 'neral', version: 1,
  onsets: ['n','m','l','r','s','t','k','v','f','h'], vowels: ['a','e','i','o','u'],
  roots: { sela:'water', vara:'wood', kara:'stone', tira:'hill', lina:'valley', mora:'sea', ula:'field', nora:'home', vesa:'crossing', ara:'land' },
  suffixes: { family:'en', settlement:'nar', river:'sel', mountain:'tir', road:'ves', region:'ar' },
} as const;

function word(seed: number, key: string, syllables = 2): string {
  let result = '';
  for (let i=0; i<syllables; i++) {
    const c=NAMING_LANGUAGE.onsets[Math.floor(scopedRandom(seed,`${key}:c${i}`)*NAMING_LANGUAGE.onsets.length)]!;
    const v=NAMING_LANGUAGE.vowels[Math.floor(scopedRandom(seed,`${key}:v${i}`)*NAMING_LANGUAGE.vowels.length)]!;
    result += c+v;
  }
  return result;
}
function title(word: string): string { return word[0]!.toUpperCase()+word.slice(1); }
function join(left: string, right: string): string { return /[aeiou]$/.test(left) && left.at(-1)===right[0] ? left+right.slice(1) : left+right; }

export function generatePersonName(seed: number, id: string, householdId: string, inheritedFamily?: string) {
  const givenName=title(word(seed,`neral-v1:person:${id}`));
  const familyName=inheritedFamily ?? title(join(word(seed,`neral-v1:house:${householdId}`),NAMING_LANGUAGE.suffixes.family));
  return { languageVersion: 1 as const, givenName, familyName, fullName: `${givenName} ${familyName}` };
}

export function isNamedPlace(entity: WorldEntity): boolean {
  return ['settlement','region','terrain','route','road','waterway','landmark','anomaly'].includes(entity.kind);
}

export function generatePlaceName(entity: WorldEntity): string {
  const description=`${entity.kind} ${entity.subtype ?? ''}`;
  const root=/river|water|lake/.test(description)?'sela':/mountain|hill/.test(description)?'tira':/forest|wood/.test(description)?'vara':/valley/.test(description)?'lina':/coast|sea/.test(description)?'mora':/stone|rock/.test(description)?'kara':'ara';
  const suffix=entity.kind==='settlement'?'nar':/river|water/.test(description)?'sel':/road|route/.test(description)?'ves':entity.kind==='region'?'ar':'tir';
  return title(join(word(0,`neral-v1:place:${entity.id}`),join(root,suffix)));
}

export function initializeNames(state: SandboxGameState): void {
  for (const agent of state.agents) {
    const generated=generatePersonName(state.seed,agent.id,agent.householdId);
    agent.naming={...generated, sourceName:agent.name}; agent.name=generated.fullName;
    if (agent.profileAuthority) agent.profileAuthority.name='game-derived';
  }
  const origin=state.world.providerSnapshot.entities.find((entry)=>entry.id===state.world.originEntityId);
  if (origin) state.settlement.name=generatePlaceName(origin);
}
