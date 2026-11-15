import type { FrameId } from "./frame.ts";

/**
 * §8 of RUNTIME_ABI: ExecutionContext is a *state model*, not a language feature.
 * `return`, `throw`, `yield`, async and generators are explicitly out of scope;
 * control flow stays in IR/CFG. This module owns status transitions and frame
 * ownership so a later feature cannot invent its own private Scratch variables.
 */

export type ThreadId = string;
export type ExecutionStatus = "running" | "suspended" | "returning" | "throwing" | "completed";

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "running", "suspended", "returning", "throwing", "completed",
];

export interface ExecutionContext {
  readonly threadId: ThreadId;
  readonly frameId: FrameId | null;
  readonly status: ExecutionStatus;
}

const ALLOWED_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  running: ["suspended", "returning", "throwing", "completed"],
  suspended: ["running", "completed"],
  returning: ["completed"],
  throwing: ["completed"],
  completed: [],
};

export interface ExecutionTransition {
  readonly from: ExecutionStatus;
  readonly to: ExecutionStatus;
  readonly allowed: boolean;
}

export const EXECUTION_TRANSITION_FIXTURES: readonly ExecutionTransition[] =
  EXECUTION_STATUSES.flatMap((from) => EXECUTION_STATUSES.map((to) => ({
    from,
    to,
    allowed: ALLOWED_TRANSITIONS[from].includes(to),
  })));

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function createExecutionContext(threadId: ThreadId): ExecutionContext {
  return { threadId, frameId: null, status: "running" };
}

/** Rejects illegal transitions instead of silently producing an impossible state. */
export function transitionExecution(context: ExecutionContext, next: ExecutionStatus): ExecutionContext {
  if (!canTransition(context.status, next)) {
    throw new RangeError(
      `illegal execution transition ${context.status} -> ${next} on thread ${context.threadId}`,
    );
  }
  return { ...context, status: next };
}

export interface ExecutionTableState {
  readonly contexts: ReadonlyMap<ThreadId, ExecutionContext>;
  readonly frameOwners: ReadonlyMap<FrameId, ThreadId>;
}

export const INITIAL_EXECUTION_TABLE: ExecutionTableState = {
  contexts: new Map(),
  frameOwners: new Map(),
};

export function enterExecution(state: ExecutionTableState, threadId: ThreadId): ExecutionTableState {
  if (state.contexts.has(threadId)) throw new Error(`thread ${threadId} already has a context`);
  const contexts = new Map(state.contexts);
  contexts.set(threadId, createExecutionContext(threadId));
  return { ...state, contexts };
}

/** A frame belongs to exactly one thread. This is the ownership invariant behind re-entrancy. */
export function attachFrame(
  state: ExecutionTableState,
  threadId: ThreadId,
  frameId: FrameId,
): ExecutionTableState {
  const context = state.contexts.get(threadId);
  if (!context) throw new Error(`unknown thread ${threadId}`);
  const owner = state.frameOwners.get(frameId);
  if (owner !== undefined && owner !== threadId) {
    throw new Error(`frame ${frameId} is owned by thread ${owner}, not ${threadId}`);
  }
  const contexts = new Map(state.contexts);
  contexts.set(threadId, { ...context, frameId });
  const frameOwners = new Map(state.frameOwners);
  frameOwners.set(frameId, threadId);
  return { contexts, frameOwners };
}

export function detachFrame(state: ExecutionTableState, threadId: ThreadId): ExecutionTableState {
  const context = state.contexts.get(threadId);
  if (!context) throw new Error(`unknown thread ${threadId}`);
  const contexts = new Map(state.contexts);
  contexts.set(threadId, { ...context, frameId: null });
  const frameOwners = new Map(state.frameOwners);
  for (const [frameId, owner] of frameOwners) {
    if (owner === threadId) frameOwners.delete(frameId);
  }
  return { contexts, frameOwners };
}

export function transitionThread(
  state: ExecutionTableState,
  threadId: ThreadId,
  next: ExecutionStatus,
): ExecutionTableState {
  const context = state.contexts.get(threadId);
  if (!context) throw new Error(`unknown thread ${threadId}`);
  const contexts = new Map(state.contexts);
  contexts.set(threadId, transitionExecution(context, next));
  return { ...state, contexts };
}

export function exitExecution(state: ExecutionTableState, threadId: ThreadId): ExecutionTableState {
  const context = state.contexts.get(threadId);
  if (!context) throw new Error(`unknown thread ${threadId}`);
  const contexts = new Map(state.contexts);
  contexts.delete(threadId);
  const frameOwners = new Map(state.frameOwners);
  for (const [frameId, owner] of frameOwners) {
    if (owner === threadId) frameOwners.delete(frameId);
  }
  return { contexts, frameOwners };
}

export function contextFor(state: ExecutionTableState, threadId: ThreadId): ExecutionContext | undefined {
  return state.contexts.get(threadId);
}

export function ownerOfFrame(state: ExecutionTableState, frameId: FrameId): ThreadId | undefined {
  return state.frameOwners.get(frameId);
}

export interface ExecutionConformanceResult {
  checked: number;
  failures: readonly string[];
}

/** Full status-transition matrix plus the cross-thread ownership invariant. */
export function runExecutionConformance(): ExecutionConformanceResult {
  const failures: string[] = [];
  let checked = 0;
  for (const fixture of EXECUTION_TRANSITION_FIXTURES) {
    checked += 1;
    const context: ExecutionContext = {
      threadId: "t", frameId: null, status: fixture.from,
    };
    let ok = true;
    try {
      const next = transitionExecution(context, fixture.to);
      ok = next.status === fixture.to;
    } catch {
      ok = false;
    }
    if (ok !== fixture.allowed) {
      failures.push(`${fixture.from} -> ${fixture.to}: expected allowed=${fixture.allowed}, got ${ok}`);
    }
  }
  let state = enterExecution(INITIAL_EXECUTION_TABLE, "a");
  state = enterExecution(state, "b");
  state = attachFrame(state, "a", 0);
  checked += 1;
  if (ownerOfFrame(state, 0) !== "a") failures.push("frame 0 should be owned by thread a");
  try {
    attachFrame(state, "b", 0);
    failures.push("two threads were allowed to own frame 0");
  } catch {
    checked += 1;
  }
  state = detachFrame(state, "a");
  checked += 1;
  if (ownerOfFrame(state, 0) !== undefined) failures.push("detachFrame left an owner behind");
  state = transitionThread(state, "b", "suspended");
  state = transitionThread(state, "b", "running");
  checked += 1;
  if (contextFor(state, "b")?.status !== "running") failures.push("resume did not return to running");
  return { checked, failures };
}
