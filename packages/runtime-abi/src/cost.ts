import type { AbiContract } from "./capability.ts";

/**
 * §3 of RUNTIME_ABI: the planner charges ABI operations explicitly (frame
 * push/pop, tag/untag, heap access). §9.2: consecutive operations in one region
 * cross the Native/Extension boundary once, not once per operation.
 */

export type AbiOperationKind =
  | "frame.allocate"
  | "frame.return"
  | "value.tag"
  | "value.untag"
  | "heap.allocate"
  | "heap.field.read"
  | "heap.field.write"
  | "heap.array.read"
  | "heap.array.write"
  | "heap.free"
  | "call"
  | "dispatch";

export interface AbiOperationSpec {
  readonly kind: AbiOperationKind;
  readonly contract: AbiContract;
  readonly cost: number;
}

export const ABI_OPERATION_COSTS: Readonly<Record<AbiOperationKind, AbiOperationSpec>> = {
  "frame.allocate": { kind: "frame.allocate", contract: "frame", cost: 3 },
  "frame.return": { kind: "frame.return", contract: "frame", cost: 2 },
  "value.tag": { kind: "value.tag", contract: "value", cost: 1 },
  "value.untag": { kind: "value.untag", contract: "value", cost: 1 },
  "heap.allocate": { kind: "heap.allocate", contract: "memory", cost: 4 },
  "heap.field.read": { kind: "heap.field.read", contract: "memory", cost: 2 },
  "heap.field.write": { kind: "heap.field.write", contract: "memory", cost: 2 },
  "heap.array.read": { kind: "heap.array.read", contract: "memory", cost: 3 },
  "heap.array.write": { kind: "heap.array.write", contract: "memory", cost: 3 },
  "heap.free": { kind: "heap.free", contract: "memory", cost: 3 },
  call: { kind: "call", contract: "call", cost: 3 },
  dispatch: { kind: "dispatch", contract: "dispatch", cost: 4 },
};

export interface AbiOperation {
  readonly kind: AbiOperationKind;
  readonly contract: AbiContract;
  readonly cost: number;
  readonly sequence: number;
  readonly scope: string;
}

export interface AbiRegion {
  readonly id: string;
  readonly scope: string;
  readonly operations: readonly AbiOperation[];
  readonly cost: number;
}

/** Merge consecutive ABI operations in the same script scope into one crossing. */
export function mergeAbiRegions(operations: readonly AbiOperation[]): AbiRegion[] {
  const regions: AbiRegion[] = [];
  for (const operation of operations) {
    const last = regions[regions.length - 1];
    const previous = last?.operations[last.operations.length - 1];
    if (last && previous && last.scope === operation.scope && operation.sequence === previous.sequence + 1) {
      regions[regions.length - 1] = {
        ...last,
        operations: [...last.operations, operation],
        cost: last.cost + operation.cost,
      };
      continue;
    }
    regions.push({
      id: `region:${regions.length}`,
      scope: operation.scope,
      operations: [operation],
      cost: operation.cost,
    });
  }
  return regions;
}

export interface AbiRegionSummary {
  operations: number;
  regions: number;
  boundaryCalls: number;
  cost: number;
}

export function regionSummary(regions: readonly AbiRegion[]): AbiRegionSummary {
  return {
    operations: regions.reduce((total, region) => total + region.operations.length, 0),
    regions: regions.length,
    boundaryCalls: regions.length,
    cost: regions.reduce((total, region) => total + region.cost, 0),
  };
}
