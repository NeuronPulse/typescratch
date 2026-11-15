import type { TraceValue } from "./interpreter.ts";
import { createStepSession } from "./vm.ts";

export interface TraceSnapshot {
  variables: Record<string, TraceValue>;
  lists: Record<string, TraceValue[]>;
}

export interface TraceFrame {
  frame: number;
  round: number;
  says: string[];
  variables: Record<string, TraceValue>;
  lists: Record<string, TraceValue[]>;
}

export interface RunTrace {
  says: string[];
  frames: TraceFrame[];
  /** Full, unfiltered state at the end of each green flag round. */
  roundFinals: TraceSnapshot[];
  final: TraceSnapshot;
  rounds: number;
}

export interface RecordOptions {
  greenFlags?: number;
  maxFrames?: number;
  /** Keep compiler-internal `_tscr_`, `abi.` and `heap.` state in the frame diffs. */
  includeCompilerState?: boolean;
  /** Override the key filter entirely. */
  include?: (key: string) => boolean;
}

interface VmSnapshot {
  variables: () => Record<string, TraceValue>;
  lists: () => Record<string, TraceValue[]>;
}

export function isCompilerState(key: string): boolean {
  return key.includes(":abi.") || key.includes(":heap.") || key.includes(":_tscr_");
}

function snapshot(session: VmSnapshot, include: (key: string) => boolean): TraceSnapshot {
  const variables: Record<string, TraceValue> = {};
  const lists: Record<string, TraceValue[]> = {};
  for (const [key, value] of Object.entries(session.variables())) {
    if (include(key)) variables[key] = value;
  }
  for (const [key, value] of Object.entries(session.lists())) {
    if (include(key)) lists[key] = [...value];
  }
  return { variables, lists };
}

function changedVariables(
  before: Record<string, TraceValue>,
  after: Record<string, TraceValue>,
): Record<string, TraceValue> {
  const out: Record<string, TraceValue> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!Object.is(before[key], value)) out[key] = value;
  }
  return out;
}

function changedLists(
  before: Record<string, TraceValue[]>,
  after: Record<string, TraceValue[]>,
): Record<string, TraceValue[]> {
  const out: Record<string, TraceValue[]> = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) out[key] = value;
  }
  return out;
}

/**
 * Runs a project in headless scratch-vm and records per-frame state changes.
 * `runtime._step()` drains all runnable threads in one frame, so a frame is a
 * scheduling boundary, not a single block — the diff is the net change of that frame.
 */
export async function recordTrace(sb3: Uint8Array, options: RecordOptions = {}): Promise<RunTrace> {
  const session = await createStepSession(sb3);
  const rounds = options.greenFlags ?? 1;
  const maxFrames = options.maxFrames ?? 200;
  const include = options.include
    ?? ((key: string) => options.includeCompilerState === true || !isCompilerState(key));
  const frames: TraceFrame[] = [];
  const roundFinals: TraceSnapshot[] = [];
  let previous = snapshot(session, include);
  let sayCursor = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      session.greenFlag();
      for (let step = 0; step < maxFrames && session.activeThreads() > 0; step++) {
        session.step();
        const current = snapshot(session, include);
        const says = session.says.slice(sayCursor);
        sayCursor = session.says.length;
        const frame: TraceFrame = {
          frame: frames.length,
          round,
          says,
          variables: changedVariables(previous.variables, current.variables),
          lists: changedLists(previous.lists, current.lists),
        };
        previous = current;
        if (says.length > 0
          || Object.keys(frame.variables).length > 0
          || Object.keys(frame.lists).length > 0) {
          frames.push(frame);
        }
      }
      roundFinals.push({
        variables: session.variables(),
        lists: session.lists(),
      });
    }
    return {
      says: [...session.says],
      frames,
      roundFinals,
      final: roundFinals[roundFinals.length - 1] ?? { variables: {}, lists: {} },
      rounds,
    };
  } finally {
    session.close();
  }
}

/** Human-readable log: frame diffs plus a compact per-round compiler-state summary. */
export function formatTrace(trace: RunTrace): string {
  const lines = [
    `recorded ${trace.rounds} green flag(s), ${trace.frames.length} changed frame(s), ${trace.says.length} say(s)`,
  ];
  for (const frame of trace.frames) {
    const tag = `[r${frame.round} f${frame.frame}]`;
    for (const say of frame.says) lines.push(`  ${tag} SAY ${JSON.stringify(say)}`);
    for (const [key, value] of Object.entries(frame.variables).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${tag} var  ${key} = ${JSON.stringify(value)}`);
    }
    for (const [key, value] of Object.entries(frame.lists).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${tag} list ${key} = ${JSON.stringify(value)}`);
    }
  }
  lines.push("compiler state per round (list lengths):");
  trace.roundFinals.forEach((final, round) => {
    const entries = Object.entries(final.lists)
      .filter(([key]) => isCompilerState(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value.length}`);
    lines.push(`  r${round}: ${entries.join(" ") || "<none>"}`);
  });
  return lines.join("\n");
}
