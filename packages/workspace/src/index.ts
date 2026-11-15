import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { CODES, type DiagnosticBag } from "@typescratch/diagnostics";
import type { Costume, RoleDecl, Sound } from "@typescratch/graph";

export interface WorkspaceConfig {
  name?: string;
  target?: "scratch" | "turbowarp";
  abiProfile?: string;
  src?: string;
  assets?: string;
}

export interface WorkspaceSource {
  role: string;
  isStage: boolean;
  file: string;
}

export interface Workspace {
  root: string;
  config: WorkspaceConfig;
  roles: RoleDecl[];
  sources: WorkspaceSource[];
}

interface RoleDraft extends RoleDecl {
  files: string[];
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function collectTsFiles(projectRoot: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".ts")
    .map((entry) => relative(projectRoot, join(directory, entry.name)))
    .sort();
}

export function loadWorkspace(
  projectRoot: string,
  bag: DiagnosticBag,
  configPath = "tscr.config.json",
): Workspace | undefined {
  const configFile = resolve(projectRoot, configPath);
  if (!existsSync(configFile)) return undefined;
  const config = readJson<WorkspaceConfig>(configFile);
  if (!config) {
    bag.error(CODES.TS_TYPE, `cannot parse workspace config ${configPath}`);
    return undefined;
  }

  const root = dirname(configFile);
  const srcDir = resolve(root, config.src ?? "src");
  const assetsDir = resolve(root, config.assets ?? "assets");
  if (!existsSync(srcDir)) {
    bag.error(CODES.TS_TYPE, `workspace src directory is missing: ${relative(projectRoot, srcDir)}`);
    return undefined;
  }

  const roles = new Map<string, RoleDraft>();
  const addRole = (name: string, isStage: boolean, files: string[]): void => {
    const existing = roles.get(name);
    if (existing) existing.files.push(...files);
    else roles.set(name, { name, isStage, files: [...files] });
  };

  for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && extname(entry.name) === ".ts") {
      const name = basename(entry.name, ".ts");
      addRole(name, name.toLowerCase() === "stage", [relative(projectRoot, join(srcDir, entry.name))]);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const name = entry.name.startsWith("&") ? entry.name.slice(1) : entry.name;
    const roleDir = join(srcDir, entry.name);
    addRole(name, name.toLowerCase() === "stage", collectTsFiles(projectRoot, roleDir));
    for (const nested of readdirSync(roleDir, { withFileTypes: true })) {
      if (!nested.isDirectory() || !nested.name.startsWith("&")) continue;
      const nestedName = nested.name.slice(1);
      addRole(nestedName, false, collectTsFiles(projectRoot, join(roleDir, nested.name)));
    }
  }

  const declared = readJson<{ sprites?: string[] }>(join(root, "project.d.json"));
  for (const sprite of declared?.sprites ?? []) {
    if (!roles.has(sprite)) addRole(sprite, false, []);
  }
  if (![...roles.values()].some((role) => role.isStage)) {
    roles.set("Stage", { name: "Stage", isStage: true, files: [] });
  }
  if (![...roles.values()].some((role) => !role.isStage)) {
    roles.set("Sprite1", { name: "Sprite1", isStage: false, files: [] });
  }

  for (const role of roles.values()) {
    const candidates = role.isStage
      ? [join(assetsDir, "Stage"), join(assetsDir, "stage")]
      : [join(assetsDir, role.name)];
    const roleAssetsDir = candidates.find((candidate) => existsSync(candidate));
    if (!roleAssetsDir) continue;
    const contents = new Map<string, Uint8Array>();
    const costumes: Costume[] = [];
    const sounds: Sound[] = [];

    const costumeDir = role.isStage && existsSync(join(roleAssetsDir, "backdrops"))
      ? "backdrops"
      : "costumes";
    const costumeManifest = role.isStage && costumeDir === "backdrops"
      ? "backdrops.json"
      : "costumes.json";
    const costumesJson = readJson<{
      name: string; file: string;
      bitmapResolution?: number; rotationCenterX?: number; rotationCenterY?: number;
    }[]>(join(roleAssetsDir, costumeDir, costumeManifest)) ?? [];
    for (const item of costumesJson) {
      const path = join(roleAssetsDir, costumeDir, item.file);
      if (!existsSync(path)) {
        bag.error(CODES.TS_TYPE, `costume file is missing: ${relative(projectRoot, path)}`);
        continue;
      }
      const key = `${role.name}:costume:${item.file}`;
      contents.set(key, new Uint8Array(readFileSync(path)));
      costumes.push({
        assetKey: key,
        name: item.name,
        dataFormat: extname(item.file).slice(1) || "svg",
        bitmapResolution: item.bitmapResolution ?? 2,
        rotationCenterX: item.rotationCenterX ?? 0,
        rotationCenterY: item.rotationCenterY ?? 0,
      });
    }

    const soundsJson = readJson<{
      name: string; file: string; rate?: number; sampleCount?: number;
    }[]>(join(roleAssetsDir, "sound", "sound.json")) ?? [];
    for (const item of soundsJson) {
      const path = join(roleAssetsDir, "sound", item.file);
      if (!existsSync(path)) {
        bag.error(CODES.TS_TYPE, `sound file is missing: ${relative(projectRoot, path)}`);
        continue;
      }
      const key = `${role.name}:sound:${item.file}`;
      contents.set(key, new Uint8Array(readFileSync(path)));
      sounds.push({
        assetKey: key,
        name: item.name,
        dataFormat: extname(item.file).slice(1) || "wav",
        rate: item.rate ?? 44100,
        sampleCount: item.sampleCount ?? 0,
      });
    }

    role.properties = readJson<Record<string, unknown>>(join(roleAssetsDir, "sprite.json"))
      ?? readJson<Record<string, unknown>>(join(roleAssetsDir, "stage.json"))
      ?? {};
    if (costumes.length > 0) role.costumes = costumes;
    role.sounds = sounds;
    role.assets = contents;
  }

  const sources: WorkspaceSource[] = [...roles.values()].flatMap((role) =>
    role.files.map((file) => ({ role: role.name, isStage: role.isStage, file })),
  );
  return {
    root,
    config,
    roles: [...roles.values()],
    sources,
  };
}
