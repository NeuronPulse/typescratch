export type AbiProfile = "native" | "extension" | "auto";

export const ABI_PROFILES: readonly AbiProfile[] = ["native", "extension", "auto"];

export interface AbiProfileSelection {
  requested: AbiProfile;
  resolved: "native" | "extension";
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

export function selectProfile(requested: string, target: "scratch" | "turbowarp"): AbiProfileSelection {
  const profile: AbiProfile = isAbiProfile(requested) ? requested : "auto";
  return { requested: profile, resolved: resolveProfile(profile, target) };
}
