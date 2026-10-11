import type { WorldRecipe, WorldSnapshot } from './contract.js';
import { WorldgenEngine } from './engine.js';
export interface ReplayDiagnostic {
    deterministic: boolean;
    firstDigest: string;
    secondDigest: string;
    entityCount: number;
    eventCount: number;
}
export declare function diagnoseDeterministicReplay(recipe: WorldRecipe, engine?: WorldgenEngine): Promise<ReplayDiagnostic>;
export declare function validateSnapshotConformance(snapshot: WorldSnapshot): string[];
export declare function validateComponentSchemas(snapshot: WorldSnapshot, recipe: WorldRecipe): string[];
export interface PopulationReconstructionDiagnostic {
    reconstructed: Record<string, number>;
    canonical: Record<string, number>;
    maxAbsoluteError: number;
    totalAbsoluteError: number;
    exact: boolean;
    appliedEventKinds: string[];
    missingSeedSettlementIds: string[];
}
/**
 * Reconstructs settlement population from generation premises plus retained burn-in events.
 * This intentionally ignores the present population component until the final comparison.
 */
export declare function reconstructPopulationFromHistory(snapshot: WorldSnapshot): PopulationReconstructionDiagnostic;
export interface MaterialHistoryReconstructionDiagnostic {
    exact: boolean;
    resourceStockError: number;
    infrastructureConditionError: number;
    polityStateError: number;
    reconstructedResourceStocks: Record<string, number>;
    reconstructedInfrastructureCondition: Record<string, number>;
    reconstructedPolityState: Record<string, {
        institutionalCapacityIndex: number;
        logisticsAccessIndex: number;
        population: number;
    }>;
    appliedEventKinds: string[];
}
/** Reconstructs non-population material state from explicit premises and retained state-transition events. */
export declare function reconstructMaterialSystemsFromHistory(snapshot: WorldSnapshot): MaterialHistoryReconstructionDiagnostic;
