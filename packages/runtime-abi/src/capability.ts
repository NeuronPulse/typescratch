import type { AbiLowering } from "./profile.ts";

/**
 * §2 of RUNTIME_ABI: a target implements a subset of the six contracts, never a
 * private dialect, and unsupported contracts fail at plan time with a diagnostic.
 */

export type AbiContract = "value" | "call" | "frame" | "memory" | "dispatch" | "execution";

export const ABI_CONTRACTS: readonly AbiContract[] = [
  "value", "call", "frame", "memory", "dispatch", "execution",
];

export type AbiUsage = Record<AbiContract, boolean>;

export const NO_ABI_USAGE: AbiUsage = {
  value: false,
  call: false,
  frame: false,
  memory: false,
  dispatch: false,
  execution: false,
};

/**
 * Native implements all six contracts (Execution is a state model only).
 * The Extension profile is defined by §9 but has no runtime yet; the compiler
 * rejects an explicit request before planning, and this table keeps the reason
 * machine-checkable rather than duplicated in ad-hoc conditionals.
 */
export function capabilitiesFor(profile: AbiLowering): readonly AbiContract[] {
  return profile === "native" ? ABI_CONTRACTS : [];
}

export function requiredContracts(usage: AbiUsage): AbiContract[] {
  return ABI_CONTRACTS.filter((contract) => usage[contract]);
}

export function unsupportedContracts(profile: AbiLowering, usage: AbiUsage): AbiContract[] {
  const supported = new Set(capabilitiesFor(profile));
  return requiredContracts(usage).filter((contract) => !supported.has(contract));
}

export function mergeUsage(left: AbiUsage, right: AbiUsage): AbiUsage {
  return {
    value: left.value || right.value,
    call: left.call || right.call,
    frame: left.frame || right.frame,
    memory: left.memory || right.memory,
    dispatch: left.dispatch || right.dispatch,
    execution: left.execution || right.execution,
  };
}
