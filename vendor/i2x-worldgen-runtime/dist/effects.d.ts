import type { JsonValue } from './contract.js';
export interface WorldLawEffectOperatorContext {
    currentValue: JsonValue;
    effect: Record<string, JsonValue>;
    interactionScale: number;
    randomUnit: number;
}
export interface WorldLawEffectOperator {
    id: string;
    apply(context: WorldLawEffectOperatorContext): JsonValue | undefined;
}
export declare class WorldLawEffectOperatorRegistry {
    #private;
    register(operator: WorldLawEffectOperator): this;
    get(id: string): WorldLawEffectOperator | undefined;
    require(id: string): WorldLawEffectOperator;
    list(): WorldLawEffectOperator[];
}
export declare const worldLawEffectOperatorRegistry: WorldLawEffectOperatorRegistry;
