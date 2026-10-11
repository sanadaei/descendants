import { scopedRandom } from './rng.js';
import type { SandboxAgent, SandboxGameState, SkillKey } from './types.js';

function curve(age: number, points: Array<[number, number]>): number {
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1]!; const right = points[i]!;
    if (age <= right[0]) return left[1] + (right[1] - left[1]) * Math.max(0, age - left[0]) / (right[0] - left[0]);
  }
  return points.at(-1)![1];
}

/** Game calibration, not a medical model. Skills remain learned; age modifies performance. */
export function ageAbilityFactors(age: number) {
  return {
    physical: curve(age, [[0,.1],[6,.35],[13,.7],[20,1],[35,1],[55,.85],[75,.55],[95,.25],[115,.12]]),
    judgment: curve(age, [[0,.08],[6,.3],[13,.65],[25,1],[60,1],[85,.85],[105,.65]]),
    recovery: curve(age, [[0,1.15],[20,1],[40,1],[60,.8],[80,.5],[105,.25]]),
    learning: curve(age, [[0,.3],[6,1.15],[18,1],[45,.95],[75,.7],[105,.4]]),
  };
}

export function agentAbilityFactors(state: SandboxGameState, agent: SandboxAgent) {
  return ageAbilityFactors(Math.max(0, (state.clock.day + state.clock.minuteOfDay / 1440 - agent.bornDay) / 365));
}

export function ageSkillFactor(state: SandboxGameState, agent: SandboxAgent, skill: SkillKey): number {
  const factors = agentAbilityFactors(state, agent);
  const bodily = ['combat','scouting','construction','foraging','survival'].includes(skill);
  return bodily ? factors.physical : skill === 'medicine' || skill === 'care' ? (factors.physical + factors.judgment * 2) / 3 : factors.judgment;
}

/** Identity-scoped lifetime: unrelated RNG draws, tick subdivision and reload cannot change it. */
export function naturalDeathDay(state: SandboxGameState, agent: SandboxAgent): number {
  const roll = scopedRandom(state.seed, `life-v1:${agent.identityAnchorId ?? agent.id}:${agent.bornDay}`);
  const resilience = Math.max(0, Math.min(100, agent.genetics.loci.resilience ?? 50));
  const years = 62 + 34 * Math.sqrt(roll) + (resilience - 50) / 10;
  return agent.bornDay + Math.floor(years * 365);
}
