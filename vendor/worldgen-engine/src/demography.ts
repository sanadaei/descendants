import type { JsonValue, WorldEntity, WorldTick } from './contract.js';

export interface DemographyPolicyContext {
  settlement: WorldEntity;
  cohort?: WorldEntity;
  tick: WorldTick;
  ticksPerDay: number;
  shortageIndex: number;
  productionIndex: number;
  currentPopulation: number;
  policyConfig: Record<string, JsonValue>;
}

export interface DemographyPolicyResult {
  birthRatePerDay?: number;
  deathRatePerDay?: number;
  healthDelta?: number;
  dependencySupportDelta?: number;
  householdFormationMultiplier?: number;
  householdDissolutionMultiplier?: number;
}

export interface DemographyPolicy {
  id: string;
  evaluate(context: DemographyPolicyContext): DemographyPolicyResult;
}

export class DemographyPolicyRegistry {
  readonly #policies = new Map<string, DemographyPolicy>();
  register(policy: DemographyPolicy): this {
    if (!policy.id) throw new Error('Demography policy id is required');
    if (this.#policies.has(policy.id)) throw new Error(`Duplicate demography policy: ${policy.id}`);
    this.#policies.set(policy.id, policy);
    return this;
  }
  unregister(id: string): boolean { return this.#policies.delete(id); }
  get(id: string): DemographyPolicy | undefined { return this.#policies.get(id); }
  require(id: string): DemographyPolicy {
    const policy = this.#policies.get(id);
    if (!policy) throw new Error(`Demography policy not registered: ${id}`);
    return policy;
  }
  list(): DemographyPolicy[] { return [...this.#policies.values()]; }
}

export const demographyPolicyRegistry = new DemographyPolicyRegistry();
