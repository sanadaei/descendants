import type { WorldProvider } from '../worldbridge/contract.js';
import { commitDailyPlan, ensureDailyLoopState, executeCommittedPlan } from './dailyActionLoop.js';
import type { SandboxGameState } from './types.js';

export async function executeContinuityDays(provider: WorldProvider, state: SandboxGameState, days: number, options: {
  cancelled?: () => boolean;
  onDay?: (completed: number) => Promise<void>;
} = {}): Promise<{ completedDays: number; reason: string }> {
  if (!Number.isInteger(days) || days<1 || days>365) throw new Error('Continuity advance must be 1–365 days.');
  let completedDays=0;
  while (completedDays<days) {
    if (options.cancelled?.()) return {completedDays,reason:'停止しました。'};
    const field=state.expeditions.find((e)=>e.controlMode==='expedition'&&['outbound','exploring','returning'].includes(e.status));
    if (field && state.encounters.some((e)=>e.expeditionId===field.id&&e.status!=='resolved')) return {completedDays,reason:'直接遭遇への対応が必要です。'};
    const loop=ensureDailyLoopState(state);
    if (loop.phase==='interrupted') return {completedDays,reason:'日次計画への対応が必要です。'};
    if (loop.currentPlan.status==='draft') commitDailyPlan(state);
    const result=await executeCommittedPlan(provider,state);
    if (result.status==='interrupted') return {completedDays,reason:result.interruption.title};
    completedDays++;
    await options.onDay?.(completedDays);
    if (result.report.births.length || result.report.deaths.length) return {completedDays,reason:'出生・死亡がありました。年代記と配置を確認してください。'};
    if (result.report.residentDeltas.some((r)=>r.severity==='critical')) return {completedDays,reason:'住民の危機状態を確認してください。'};
  }
  return {completedDays,reason:'指定した期間を完了しました。'};
}
