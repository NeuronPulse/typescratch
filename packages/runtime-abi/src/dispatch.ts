export interface DispatchTargetSpec {
  readonly classId: string;
  readonly function: string;
}

export interface DispatchClassSpec {
  readonly id: string;
  readonly methods: readonly string[];
}

export function dispatchKey(classId: string, method: string): string {
  return `${classId}::${method}`;
}

/**
 * A call site emits one dispatch operation. Collecting the implementations here keeps the
 * type tests out of IR and makes the profile own the mechanics (§7 of RUNTIME_ABI).
 */
export function dispatchTargets(
  classes: readonly DispatchClassSpec[],
  method: string,
  functionIdFor: (classId: string, method: string) => string,
): DispatchTargetSpec[] {
  return classes
    .filter((entry) => entry.methods.includes(method))
    .map((entry) => ({ classId: entry.id, function: functionIdFor(entry.id, method) }));
}

export function dispatchCost(targets: readonly DispatchTargetSpec[]): number {
  return targets.length === 0 ? 0 : targets.length + 1;
}

export function isDispatchExhaustive(
  targets: readonly DispatchTargetSpec[],
  classes: readonly DispatchClassSpec[],
  method: string,
): boolean {
  const expected = classes.filter((entry) => entry.methods.includes(method)).length;
  return targets.length === expected && expected > 0;
}
