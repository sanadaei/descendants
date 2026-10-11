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

export class WorldLawEffectOperatorRegistry {
  readonly #operators = new Map<string, WorldLawEffectOperator>();
  register(operator: WorldLawEffectOperator): this {
    if (!operator.id) throw new Error('World-law effect operator id is required');
    if (this.#operators.has(operator.id)) throw new Error(`Duplicate world-law effect operator: ${operator.id}`);
    this.#operators.set(operator.id, operator);
    return this;
  }
  get(id: string): WorldLawEffectOperator | undefined { return this.#operators.get(id); }
  require(id: string): WorldLawEffectOperator {
    const operator = this.get(id);
    if (!operator) throw new Error(`World-law effect operator not registered: ${id}`);
    return operator;
  }
  list(): WorldLawEffectOperator[] { return [...this.#operators.values()]; }
}

export const worldLawEffectOperatorRegistry = new WorldLawEffectOperatorRegistry();
