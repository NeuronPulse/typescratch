import { chooseProfile } from "./capability.ts";
import type { AbiContract } from "./capability.ts";

export type AbiProfile = "native" | "extension" | "auto";
export type AbiLowering = "native" | "extension";

export const ABI_PROFILES: readonly AbiProfile[] = ["native", "extension", "auto"];

/**
 * The default runtime. Route A (2026-11-16) implements Frame storage and the
 * four Extension frame primitives, so `extension` is now a real profile —
 * see `contractStrategy` for the per-contract Native/Extension split.
 */
export const ABI_LOWERING: AbiLowering = "native";

export interface AbiProfileSelection {
  requested: AbiProfile;
  resolved: AbiLowering;
  lowering: AbiLowering;
  reason: string;
}

export function isAbiProfile(value: string): value is AbiProfile {
  return ABI_PROFILES.some((profile) => profile === value);
}

export function allowedProfiles(target: "scratch" | "turbowarp"): readonly AbiProfile[] {
  return target === "scratch" ? ["native", "auto"] : ABI_PROFILES;
}

export function resolveProfile(profile: AbiProfile, target: "scratch" | "turbowarp"): "native" | "extension" {
  if (profile === "native") return "native";
  if (profile === "extension") return "extension";
  return target === "scratch" ? "native" : "extension";
}

export function isProfileAllowed(requested: string, target: "scratch" | "turbowarp"): boolean {
  return isAbiProfile(requested) && allowedProfiles(target).some((profile) => profile === requested);
}

export function isProfileImplemented(requested: string): boolean {
  // Route A: Extension implements Frame storage; Call/Memory/Dispatch stay
  // Native by declared mixed lowering. The profile is genuinely available.
  return isAbiProfile(requested);
}

export function selectProfile(
  requested: string,
  target: "scratch" | "turbowarp",
  required: readonly AbiContract[] = [],
): AbiProfileSelection {
  const profile: AbiProfile = isAbiProfile(requested) ? requested : "auto";
  const choice = chooseProfile(profile, target, required);
  return {
    requested: profile,
    resolved: choice.profile,
    // Route A: the resolved profile is the actual ABI emitter. Frame storage
    // moves to Extension; other contracts stay Native (see contractStrategy).
    lowering: choice.profile,
    reason: choice.reason,
  };
}
