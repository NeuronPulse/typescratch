import type { AbiLowering, AbiProfile } from "./profile.ts";

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

/**
 * §5.8 Route A is an explicitly mixed implementation. This is the *actual*
 * emitter per contract, not what `--abi-profile` was asked for. Frame storage
 * is the only contract Extension owns; Call/Value/Memory/Dispatch keep their
 * Native implementation. BuildReport must expose this table, never a single
 * "extension" label that conceals the split.
 */
export function contractStrategy(
  contract: AbiContract,
  profile: AbiLowering,
): "native" | "extension" {
  if (profile === "native") return "native";
  return contract === "frame" ? "extension" : "native";
}

export function requiredContracts(usage: AbiUsage): AbiContract[] {
  return ABI_CONTRACTS.filter((contract) => usage[contract]);
}

export function unsupportedContracts(profile: AbiLowering, usage: AbiUsage): AbiContract[] {
  const supported = new Set(capabilitiesFor(profile));
  return requiredContracts(usage).filter((contract) => !supported.has(contract));
}

/** Relative cost of a boundary crossing. Extension JS is cheaper per operation. */
const PROFILE_COST: Readonly<Record<AbiLowering, number>> = { extension: 1, native: 8 };

export interface ProfileChoice {
  readonly profile: AbiLowering;
  readonly reason: string;
}

/**
 * §3 decision order: static lowering first, then honour `--abi-profile`; `auto`
 * prefers the cheapest profile that implements every required contract. The
 * planner never silently selects a strategy with different semantics.
 */
export function chooseProfile(
  requested: AbiProfile,
  target: "scratch" | "turbowarp",
  required: readonly AbiContract[] = [],
): ProfileChoice {
  if (requested !== "auto") {
    const profile: AbiLowering = requested === "native" ? "native" : "extension";
    return { profile, reason: `explicit --abi-profile ${requested}` };
  }
  const permitted: readonly AbiLowering[] = target === "scratch"
    ? ["native"]
    : ["extension", "native"];
  const capable = permitted
    .filter((profile) => {
      const supported = capabilitiesFor(profile);
      // A profile that implements no contract at all is not a capable runtime,
      // even when this particular project happens to need no ABI operation.
      return supported.length > 0
        && required.every((contract) => supported.includes(contract));
    })
    .sort((left, right) => PROFILE_COST[left] - PROFILE_COST[right]);
  const chosen = capable[0];
  const label = required.length > 0 ? required.join(", ") : "no ABI contracts";
  if (!chosen) {
    return { profile: "native", reason: `auto: no capable profile for [${label}], falling back to native` };
  }
  return { profile: chosen, reason: `auto: cheapest capable profile for [${label}]` };
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
