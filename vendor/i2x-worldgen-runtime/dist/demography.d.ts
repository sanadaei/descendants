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
export declare class DemographyPolicyRegistry {
    #private;
    register(policy: DemographyPolicy): this;
    unregister(id: string): boolean;
    get(id: string): DemographyPolicy | undefined;
    require(id: string): DemographyPolicy;
    list(): DemographyPolicy[];
}
export declare const demographyPolicyRegistry: DemographyPolicyRegistry;
