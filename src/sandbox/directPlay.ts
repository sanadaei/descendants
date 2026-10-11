import { generatePlaceName, isNamedPlace } from './naming.js';
import type { WorldEntity } from '../worldbridge/contract.js';
import { clamp, findAgent, nextStateId } from './stateUtils.js';
import type {
  DirectActivityKind, DirectActivityReservation, DirectPlayState, EquipmentSlot, PersonalEquipmentItem,
  PhysicalInventoryItem, SandboxAgent, SandboxGameState, SkillKey,
} from './types.js';
import { consumeResourceLots } from './resourceLedger.js';

const SKILLS: SkillKey[] = ['survival','medicine','construction','foraging','scouting','combat','care','records','leadership','trade'];

function hashText(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash >>> 0;
}

function absoluteMinute(state: SandboxGameState): number { return (state.clock.day - 1) * 1440 + state.clock.minuteOfDay; }

function equipmentSpecs(agent: SandboxAgent): Array<{ name: string; slot: EquipmentSlot; weightKg: number; skill: SkillKey; bonus: number }> {
  const role = agent.role;
  const roleSpec: Partial<Record<SandboxAgent['role'], { name: string; slot: EquipmentSlot; weightKg: number; skill: SkillKey; bonus: number }>> = {
    medic: { name: 'Field medical roll', slot: 'tool', weightKg: 1.4, skill: 'medicine', bonus: 8 },
    scout: { name: 'Rangefinder notebook', slot: 'tool', weightKg: 0.8, skill: 'scouting', bonus: 8 },
    builder: { name: 'Repair tool wrap', slot: 'tool', weightKg: 2.5, skill: 'construction', bonus: 8 },
    forager: { name: 'Foraging knife and bags', slot: 'tool', weightKg: 1.2, skill: 'foraging', bonus: 8 },
    water: { name: 'Water testing kit', slot: 'tool', weightKg: 1.5, skill: 'survival', bonus: 7 },
    caregiver: { name: 'Care satchel', slot: 'tool', weightKg: 1.1, skill: 'care', bonus: 8 },
    recorder: { name: 'Weatherproof record case', slot: 'tool', weightKg: 1.0, skill: 'records', bonus: 8 },
    guard: { name: 'Guard utility rig', slot: 'tool', weightKg: 2.1, skill: 'combat', bonus: 8 },
    generalist: { name: 'General field kit', slot: 'tool', weightKg: 1.6, skill: 'survival', bonus: 5 },
    leader: { name: 'Command field folio', slot: 'tool', weightKg: 1.0, skill: 'leadership', bonus: 7 },
  };
  const base: Array<{ name: string; slot: EquipmentSlot; weightKg: number; skill: SkillKey; bonus: number }> = [
    { name: 'Work clothes', slot: 'body' as const, weightKg: 1.3, skill: 'survival' as const, bonus: 1 },
    { name: 'Weather shell', slot: 'outer' as const, weightKg: 1.1, skill: 'survival' as const, bonus: 2 },
    { name: 'Field boots', slot: 'feet' as const, weightKg: 1.4, skill: 'scouting' as const, bonus: 2 },
  ];
  const specialist = roleSpec[role];
  if (specialist) base.push(specialist);
  // Deterministic low-amplitude variation keeps generated gear tied to the person without consuming game RNG.
  const h = hashText(agent.id + ':' + role);
  if (agent.role !== 'child' && h % 3 === 0) base.push({ name: 'Protective gloves', slot: 'hands', weightKg: 0.4, skill: 'construction', bonus: 1 });
  return base;
}

export function ensureDirectPlayState(state: SandboxGameState): DirectPlayState {
  const direct = state.directPlay ?? (state.directPlay = { equipmentInitializedAgentIds: [], equipment: [], inventory: [], directActivities: [] });
  direct.equipmentInitializedAgentIds ??= [];
  direct.equipment ??= [];
  direct.inventory ??= [];
  direct.directActivities ??= [];
  for (const agent of state.agents) ensureAgentEquipment(state, agent.id);
  applyEquipmentBonuses(state);
  return direct;
}

export function ensureAgentEquipment(state: SandboxGameState, agentId: string): PersonalEquipmentItem[] {
  const direct = state.directPlay ?? (state.directPlay = { equipmentInitializedAgentIds: [], equipment: [], inventory: [], directActivities: [] });
  if (direct.equipmentInitializedAgentIds.includes(agentId)) return direct.equipment.filter((item) => item.ownerId === agentId);
  const agent = findAgent(state, agentId); if (!agent) return [];
  const specs = equipmentSpecs(agent);
  const usedSlots = new Set<EquipmentSlot>();
  for (const [index, spec] of specs.entries()) {
    const equipped = !usedSlots.has(spec.slot);
    if (equipped) usedSlots.add(spec.slot);
    direct.equipment.push({
      id: `equipment:${agent.id}:${index + 1}`, ownerId: agent.id, name: spec.name, slot: spec.slot, equipped,
      weightKg: spec.weightKg, skillBonuses: { [spec.skill]: spec.bonus }, provenanceIds: [`generated-profile:${agent.id}`, `role:${agent.role}`],
    });
  }
  direct.equipmentInitializedAgentIds.push(agentId);
  applyEquipmentBonuses(state, agentId);
  return direct.equipment.filter((item) => item.ownerId === agentId);
}

export function applyEquipmentBonuses(state: SandboxGameState, onlyAgentId?: string): void {
  const direct = state.directPlay; if (!direct) return;
  const agents = onlyAgentId ? state.agents.filter((agent) => agent.id === onlyAgentId) : state.agents;
  for (const agent of agents) {
    for (const skill of SKILLS) agent.experience[`equipment:skill:${skill}`] = 0;
    for (const item of direct.equipment.filter((candidate) => candidate.ownerId === agent.id && candidate.equipped)) {
      for (const [skill, value] of Object.entries(item.skillBonuses)) agent.experience[`equipment:skill:${skill}`] = (agent.experience[`equipment:skill:${skill}`] ?? 0) + Number(value ?? 0);
    }
  }
}

export function setEquipmentEquipped(state: SandboxGameState, agentId: string, itemId: string, equipped: boolean): PersonalEquipmentItem {
  ensureDirectPlayState(state);
  const item = state.directPlay!.equipment.find((candidate) => candidate.id === itemId && candidate.ownerId === agentId);
  if (!item) throw new Error('Equipment item is not owned by this person.');
  if (equipped) for (const other of state.directPlay!.equipment) if (other.ownerId === agentId && other.slot === item.slot && other.id !== item.id) other.equipped = false;
  item.equipped = equipped;
  applyEquipmentBonuses(state, agentId);
  return item;
}

export function equipmentForAgent(state: SandboxGameState, agentId: string): PersonalEquipmentItem[] {
  ensureDirectPlayState(state);
  return state.directPlay!.equipment.filter((item) => item.ownerId === agentId);
}

export function inventoryForAgent(state: SandboxGameState, agentId: string): PhysicalInventoryItem[] {
  ensureDirectPlayState(state);
  return state.directPlay!.inventory.filter((item) => item.ownerId === agentId && item.quantity > 0);
}

export function collectPhysicalSample(state: SandboxGameState, agentId: string, entity: WorldEntity): PhysicalInventoryItem {
  const direct = ensureDirectPlayState(state);
  if (!entity.spatial) throw new Error('Cannot sample a non-spatial entity.');
  const sampleable = entity.kind === 'anomaly' || /resource|ecolog|archaeolog|histor|ruin|trace|material/i.test(`${entity.kind} ${entity.subtype ?? ''} ${(entity.tags ?? []).join(' ')}`);
  if (!sampleable) throw new Error('This generated entity has no physically sampleable material at the current abstraction.');
  const existing = direct.inventory.find((item) => item.ownerId === agentId && item.kind === 'sample' && item.sourceEntityId === entity.id);
  if (existing) { existing.quantity += 1; return existing; }
  const item: PhysicalInventoryItem = {
    id: nextStateId(state, 'item'), ownerId: agentId, kind: 'sample', name: `Sample · ${entityName(entity)}`, quantity: 1, weightKg: 0.25,
    sourceEntityId: entity.id, provenanceIds: [...entity.provenanceIds, `sample-source:${entity.id}`], acquiredDay: state.clock.day,
  };
  direct.inventory.push(item);
  return item;
}

export function entityName(entity: WorldEntity): string {
  if (isNamedPlace(entity)) return generatePlaceName(entity);
  const name = entity.components.name ?? entity.components.label;
  return typeof name === 'string' ? name : `${entity.kind} ${entity.id}`;
}

export function reserveDirectActivity(
  state: SandboxGameState, agentIds: string[], kind: DirectActivityKind, durationMinutes: number, detail: string, targetEntityId?: string,
): DirectActivityReservation {
  const direct = ensureDirectPlayState(state);
  const start = absoluteMinute(state); const duration = Math.max(1, Math.floor(durationMinutes));
  const activity: DirectActivityReservation = {
    id: nextStateId(state, 'activity'), agentIds: [...new Set(agentIds)], kind, startAbsoluteMinute: start, endAbsoluteMinute: start + duration,
    detail, completed: false, ...(targetEntityId ? { targetEntityId } : {}),
  };
  direct.directActivities.push(activity);
  if (direct.directActivities.length > 160) direct.directActivities.splice(0, direct.directActivities.length - 160);
  return activity;
}

export function reservedHoursDuringCurrentInterval(state: SandboxGameState, agentId: string, hours: number): number {
  const direct = state.directPlay; if (!direct || hours <= 0) return 0;
  const end = absoluteMinute(state); const start = end - hours * 60;
  let reservedMinutes = 0;
  for (const activity of direct.directActivities) {
    if (!activity.agentIds.includes(agentId)) continue;
    const overlap = Math.max(0, Math.min(end, activity.endAbsoluteMinute) - Math.max(start, activity.startAbsoluteMinute));
    reservedMinutes += overlap;
  }
  return Math.min(hours, reservedMinutes / 60);
}

export function reservedHoursByKindDuringCurrentInterval(
  state: SandboxGameState, agentId: string, kind: DirectActivityKind, hours: number,
): number {
  const direct = state.directPlay; if (!direct || hours <= 0) return 0;
  const end = absoluteMinute(state); const start = end - hours * 60;
  let reservedMinutes = 0;
  for (const activity of direct.directActivities) {
    if (activity.kind !== kind || !activity.agentIds.includes(agentId)) continue;
    const overlap = Math.max(0, Math.min(end, activity.endAbsoluteMinute) - Math.max(start, activity.startAbsoluteMinute));
    reservedMinutes += overlap;
  }
  return Math.min(hours, reservedMinutes / 60);
}

export function finalizeDirectActivities(state: SandboxGameState): void {
  const direct = state.directPlay; if (!direct) return;
  const now = absoluteMinute(state);
  for (const activity of direct.directActivities) if (activity.endAbsoluteMinute <= now) activity.completed = true;
}

export function consumeAccessibleSupply(state: SandboxGameState, agentId: string, kind: 'food' | 'water' | 'medicine'): void {
  const agent = findAgent(state, agentId); if (!agent?.alive) throw new Error('Controlled person is unavailable.');
  const expedition = agent.expeditionId ? state.expeditions.find((entry) => entry.id === agent.expeditionId) : undefined;
  const stock = expedition ? expedition.supplies : state.settlement.resources;
  const amount = kind === 'medicine' ? 0.25 : 1;
  if (stock[kind] < amount) throw new Error(`No accessible ${kind} remains.`);
  if (expedition) stock[kind] -= amount;
  else consumeResourceLots(state,{resourceKey:kind,amount});
  if (kind === 'food') { agent.needs.hunger = clamp(agent.needs.hunger - 28); reserveDirectActivity(state, [agentId], 'eat', 20, 'Ate from physically accessible stock.'); }
  else if (kind === 'water') { agent.needs.thirst = clamp(agent.needs.thirst - 38); reserveDirectActivity(state, [agentId], 'drink', 10, 'Drank from physically accessible stock.'); }
  else { agent.health = clamp(agent.health + 3); reserveDirectActivity(state, [agentId], 'medicine', 20, 'Used medicine from physically accessible stock.'); }
}
