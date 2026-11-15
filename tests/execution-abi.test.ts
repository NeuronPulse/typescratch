import { test } from "vitest";
import assert from "node:assert/strict";
import {
  EXECUTION_STATUSES,
  EXECUTION_TRANSITION_FIXTURES,
  INITIAL_EXECUTION_TABLE,
  attachFrame,
  canTransition,
  contextFor,
  createExecutionContext,
  detachFrame,
  enterExecution,
  exitExecution,
  ownerOfFrame,
  runExecutionConformance,
  transitionExecution,
  transitionThread,
} from "@typescratch/runtime-abi";

test("the status transition matrix is total and conformance passes", () => {
  assert.equal(EXECUTION_TRANSITION_FIXTURES.length, EXECUTION_STATUSES.length ** 2);
  const result = runExecutionConformance();
  assert.deepEqual(result.failures, []);
  assert.ok(result.checked >= EXECUTION_STATUSES.length ** 2);
});

test("illegal transitions are rejected rather than silently applied", () => {
  assert.equal(canTransition("completed", "running"), false);
  assert.equal(canTransition("suspended", "returning"), false);
  assert.equal(canTransition("suspended", "running"), true);
  const context = createExecutionContext("main");
  assert.deepEqual(
    transitionExecution(context, "suspended"),
    { threadId: "main", frameId: null, status: "suspended" },
  );
  assert.throws(() => transitionExecution(context, "running"), /illegal execution transition/);
});

test("a frame belongs to exactly one thread and ownership is released on exit", () => {
  let state = enterExecution(INITIAL_EXECUTION_TABLE, "a");
  state = enterExecution(state, "b");
  state = attachFrame(state, "a", 0);
  assert.equal(ownerOfFrame(state, 0), "a");
  assert.throws(() => attachFrame(state, "b", 0), /owned by thread a/);

  state = transitionThread(state, "a", "suspended");
  assert.equal(contextFor(state, "a")?.status, "suspended");
  state = transitionThread(state, "a", "running");

  state = exitExecution(state, "a");
  assert.equal(contextFor(state, "a"), undefined);
  assert.equal(ownerOfFrame(state, 0), undefined);
  assert.equal(detachFrame(state, "b").contexts.get("b")?.frameId, null);
});
