import { chooseProfile } from "./capability.ts";
import type { AbiContract } from "./capability.ts";

export type AbiProfile = "native" | "extension" | "auto";
export type AbiLowering = "native" | "extension";

export const ABI_PROFILES: readonly AbiProfile[] = ["native", "extension", "auto"];

/** The runtime that actually emits lowering today. Only Native has a Call/Frame/Memory/Dispatch implementation. */
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
  return requested !== "extension" || ABI_LOWERING === "extension";
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
    lowering: ABI_LOWERING,
    reason: choice.reason,
  };
}
