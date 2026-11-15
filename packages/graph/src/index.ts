import { CODES, type DiagnosticBag, type SourceSpan } from "@typescratch/diagnostics";

export type BlockId = string;
export type Primitive =
  | [4, string]
  | [10, string]
  | [12, string, string]
  | [13, string, string];
export type Input =
  | [1, Primitive]
  | [1, BlockId]
  | [2, BlockId | null]
  | [3, BlockId | Primitive, Primitive];
export type Field = [string, string | null];
export type VariableValue = string | number | boolean;

export interface ScratchBlock {
  id: BlockId;
  opcode: string;
  next: BlockId | null;
  parent: BlockId | null;
  inputs: Record<string, Input>;
  fields: Record<string, Field>;
  shadow: boolean;
  topLevel: boolean;
  x: number;
  y: number;
  mutation?: Record<string, unknown>;
  span?: SourceSpan;
}

export interface AssetRef {
  assetKey: string;
  name: string;
  dataFormat: string;
}

export interface Costume extends AssetRef {
  bitmapResolution: number;
  rotationCenterX: number;
  rotationCenterY: number;
}

export interface Sound extends AssetRef {
  rate: number;
  sampleCount: number;
}

export interface RoleDecl {
  name: string;
  isStage: boolean;
  costumes?: Costume[];
  sounds?: Sound[];
  properties?: Record<string, unknown>;
  assets?: Map<string, Uint8Array>;
}

export interface Target {
  isStage: boolean;
  name: string;
  variables: Record<string, [string, VariableValue]>;
  lists: Record<string, [string, VariableValue[]]>;
  broadcasts: Record<string, string>;
  comments: Record<string, never>;
  blocks: Map<BlockId, ScratchBlock>;
  costumes: Costume[];
  sounds: Sound[];
  currentCostume: number;
  volume: number;
  layerOrder: number;
  tempo?: number;
  videoState?: string;
  videoTransparency?: number;
  textToSpeechLanguage?: string | null;
  visible?: boolean;
  x?: number;
  y?: number;
  size?: number;
  direction?: number;
  draggable?: boolean;
  rotationStyle?: string;
}

export interface ProjectGraph {
  targets: Target[];
  assets: Map<string, Uint8Array>;
  extensions: string[];
  extensionURLs: Record<string, string>;
  meta: { semver: string; vm: string; agent: string };
}

export type InputRef =
  | { primitive: Primitive }
  | { shadowBlock: BlockId }
  | { obscuredPrimitive: Primitive }
  | { block: BlockId };

export interface AddOptions {
  scope: string;
  span?: SourceSpan;
  parent?: BlockId | null;
  topLevel?: boolean;
  x?: number;
  y?: number;
  shadow?: boolean;
  fields?: Record<string, Field>;
  mutation?: Record<string, unknown>;
}

export const ICE_CREAM_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="46.944" height="74.148" viewBox="0 0 46.944 74.148"><g data-paper-data="{&quot;isPaintingLayer&quot;:true}" stroke-width="0" stroke-miterlimit="10" style="mix-blend-mode:normal"><path d="M12.047 15.937s22.88 7.452 22.689 7.964c-19.4 50.362-25.91 51.52-30.183 49.833-5.092-1.845-9.398-9.633 7.494-57.797" data-paper-data="{&quot;index&quot;:null}" fill="#d99e82"/><path d="M38.534 37.4c-6.17 4.912-11.357 4.95-19.424 3.753-5.066-1.212-5.27-1.378-7.629-2.49-1.685-.794-4.117-2.324-6.047-3.926-8.21-6.817-7.023-23.42 2.925-31.34C13.409-.622 18.627-.206 24.701.35c5.893.539 11.486 2.573 16.759 6.078 8.332 9.39 7.023 23.053-2.926 30.972" data-paper-data="{&quot;index&quot;:null}" fill="#fcb1e3"/></g></svg>';
export const BLANK_BACKDROP_SVG = '<svg version="1.1" width="2" height="2" viewBox="-1 -1 2 2" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><!-- Exported by Scratch - http://scratch.mit.edu/ --></svg><!--rotationCenter:240:180-->';

const DEFAULT_BACKDROP_KEY = "__tscr_default_backdrop__";
const DEFAULT_COSTUME_KEY = "__tscr_default_costume__";

const STAGE_KEYS = [
  "tempo", "videoState", "videoTransparency", "textToSpeechLanguage", "volume",
] as const;
const SPRITE_KEYS = [
  "visible", "x", "y", "size", "direction", "draggable", "rotationStyle", "volume",
] as const;

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function stableId(...parts: (string | number | undefined)[]): string {
  const text = parts.join("|");
  const forward = fnv1a(text).toString(16).padStart(8, "0");
  const backward = fnv1a([...text].reverse().join("")).toString(16).padStart(8, "0");
  return forward + backward;
}

export function defaultCostume(isStage: boolean): Costume {
  return isStage
    ? {
      assetKey: DEFAULT_BACKDROP_KEY, name: "Backdrop1", dataFormat: "svg",
      bitmapResolution: 2, rotationCenterX: 0, rotationCenterY: 0,
    }
    : {
      assetKey: DEFAULT_COSTUME_KEY, name: "Costume1", dataFormat: "svg",
      bitmapResolution: 2, rotationCenterX: 0, rotationCenterY: 0,
    };
}

function makeTarget(isStage: boolean, name: string, role: RoleDecl | undefined, assets: Map<string, Uint8Array>): Target {
  if (role?.assets) {
    for (const [key, value] of role.assets) assets.set(key, value);
  }
  const target: Target = {
    isStage,
    name,
    variables: {},
    lists: {},
    broadcasts: {},
    comments: {},
    blocks: new Map(),
    costumes: role?.costumes?.length ? role.costumes : [defaultCostume(isStage)],
    sounds: role?.sounds ?? [],
    currentCostume: 0,
    volume: 100,
    layerOrder: isStage ? 0 : 1,
    ...(isStage
      ? { tempo: 60, videoState: "on", videoTransparency: 50, textToSpeechLanguage: null }
      : {
        visible: true, x: 0, y: 0, size: 100, direction: 90,
        draggable: false, rotationStyle: "all around",
      }),
  };
  const keys = isStage ? STAGE_KEYS : SPRITE_KEYS;
  for (const key of keys) {
    const value = role?.properties?.[key];
    if (value !== undefined) (target as unknown as Record<string, unknown>)[key] = value;
  }
  return target;
}

export function createProject(roles: RoleDecl[] = []): ProjectGraph {
  const encoder = new TextEncoder();
  const assets = new Map<string, Uint8Array>([
    [DEFAULT_BACKDROP_KEY, encoder.encode(BLANK_BACKDROP_SVG)],
    [DEFAULT_COSTUME_KEY, encoder.encode(ICE_CREAM_SVG)],
  ]);
  const stageRole = roles.find((role) => role.isStage);
  const stage = makeTarget(true, "Stage", stageRole, assets);
  const spriteRoles = roles.filter((role) => !role.isStage);
  const sprites = spriteRoles.length > 0
    ? spriteRoles.map((role, index) => {
      const target = makeTarget(false, role.name, role, assets);
      target.layerOrder = index + 1;
      return target;
    })
    : [makeTarget(false, "Sprite1", undefined, assets)];
  return {
    targets: [stage, ...sprites],
    assets,
    extensions: [],
    extensionURLs: {},
    meta: { semver: "3.0.0", vm: "0.2.0", agent: "TypeScratch 0.1.0" },
  };
}

function findBlock(project: ProjectGraph, id: BlockId): ScratchBlock | undefined {
  for (const target of project.targets) {
    const block = target.blocks.get(id);
    if (block) return block;
  }
  return undefined;
}

export class GraphBuilder {
  readonly project: ProjectGraph;
  private readonly all = new Map<BlockId, ScratchBlock>();
  private readonly varNames = new Map<string, string>();
  private ordinal = 0;
  private active: Target;

  constructor(roles: RoleDecl[] = []) {
    this.project = createProject(roles);
    this.active = this.project.targets.find((target) => !target.isStage) ?? this.project.targets[0]!;
  }

  get targetNames(): string[] {
    return this.project.targets.map((target) => target.name);
  }

  setActiveTarget(name: string): void {
    const found = this.project.targets.find((target) => target.name === name);
    if (found) this.active = found;
  }

  find(id: BlockId): ScratchBlock | undefined {
    return this.all.get(id);
  }

  add(opcode: string, options: AddOptions): BlockId {
    const id = stableId(options.scope, opcode, options.span?.start ?? 0, this.ordinal++);
    const block: ScratchBlock = {
      id,
      opcode,
      next: null,
      parent: options.parent ?? null,
      inputs: {},
      fields: options.fields ?? {},
      shadow: options.shadow ?? false,
      topLevel: options.topLevel ?? false,
      x: options.x ?? 0,
      y: options.y ?? 0,
    };
    if (options.span) block.span = options.span;
    if (options.mutation) block.mutation = options.mutation;
    this.all.set(id, block);
    this.active.blocks.set(id, block);
    return id;
  }

  addShadow(opcode: string, owner: BlockId, fields: Record<string, Field>, scope: string): BlockId {
    const id = this.add(opcode, { scope, parent: owner, shadow: true, fields });
    return id;
  }

  chain(ids: BlockId[]): void {
    for (let index = 0; index < ids.length; index++) {
      const block = this.find(ids[index]!);
      if (!block) continue;
      block.next = index + 1 < ids.length ? ids[index + 1]! : null;
      if (index > 0) block.parent = ids[index - 1]!;
    }
  }

  private reparent(id: BlockId, owner: BlockId): void {
    const child = this.find(id);
    if (!child) return;
    child.parent = owner;
    child.topLevel = false;
  }

  input(owner: BlockId, name: string, ref: InputRef): void {
    const block = this.find(owner);
    if (!block) return;
    if ("primitive" in ref) {
      block.inputs[name] = [1, ref.primitive];
      return;
    }
    if ("shadowBlock" in ref) {
      block.inputs[name] = [1, ref.shadowBlock];
      this.reparent(ref.shadowBlock, owner);
      return;
    }
    if ("obscuredPrimitive" in ref) {
      block.inputs[name] = [3, ref.obscuredPrimitive, [4, ""]];
      return;
    }
    block.inputs[name] = [3, ref.block, [4, ""]];
    this.reparent(ref.block, owner);
  }

  substack(owner: BlockId, name: string, first: BlockId | undefined): void {
    if (first === undefined) return;
    const block = this.find(owner);
    if (!block) return;
    block.inputs[name] = [2, first];
    this.reparent(first, owner);
  }

  declareVariable(id: string, name: string, initial: VariableValue, storage: "global" | "local" | "temp"): void {
    const target = storage === "global" ? this.project.targets[0]! : this.active;
    target.variables[id] = [name, initial];
    this.varNames.set(id, name);
  }

  declareList(
    id: string,
    name: string,
    initial: VariableValue[],
    storage: "global" | "local" = "local",
  ): void {
    const target = storage === "global" ? this.project.targets[0]! : this.active;
    target.lists[id] = [name, initial];
    this.varNames.set(id, name);
  }

  declareBroadcast(name: string): string {
    const id = stableId("broadcast", name);
    this.project.targets[0]!.broadcasts[id] = name;
    return id;
  }

  variableName(id: string): string {
    return this.varNames.get(id) ?? id;
  }

  listName(id: string): string {
    return this.varNames.get(id) ?? id;
  }

  get blockCount(): number {
    return this.all.size;
  }

  get sourceMap(): { blockId: BlockId; span: SourceSpan }[] {
    const entries: { blockId: BlockId; span: SourceSpan }[] = [];
    for (const block of this.all.values()) {
      if (block.span) entries.push({ blockId: block.id, span: block.span });
    }
    return entries;
  }
}

export function validateGraph(project: ProjectGraph, bag: DiagnosticBag): void {
  const stages = project.targets.filter((target) => target.isStage);
  if (stages.length !== 1) {
    bag.error(CODES.NATIVE_LOWERING, `expected exactly one Stage target, found ${stages.length}`);
  }
  for (const target of project.targets) {
    if (!target.name) bag.error(CODES.NATIVE_LOWERING, "target has no name");
    if (target.costumes.length === 0) {
      bag.error(CODES.NATIVE_LOWERING, `target ${target.name} has no costume`);
    }
    for (const descriptor of [...target.costumes, ...target.sounds]) {
      if (!project.assets.has(descriptor.assetKey)) {
        bag.error(CODES.NATIVE_LOWERING, `missing asset ${descriptor.assetKey}`);
      }
    }
    for (const [id, block] of target.blocks) {
      if (id !== block.id) {
        bag.error(CODES.NATIVE_LOWERING, `block key ${id} does not match block id ${block.id}`);
      }
      if (block.next !== null) {
        const next = findBlock(project, block.next);
        if (!next) {
          bag.error(CODES.NATIVE_LOWERING, `block ${id} points to missing next ${block.next}`);
        } else if (next.parent !== id) {
          bag.error(CODES.NATIVE_LOWERING, `block ${block.next} has wrong parent`);
        }
      }
      if (block.topLevel && block.parent !== null) {
        bag.error(CODES.NATIVE_LOWERING, `top-level block ${id} has a parent`);
      }
      for (const [inputName, input] of Object.entries(block.inputs)) {
        const referenced = input[1];
        if (input[0] === 1) {
          if (Array.isArray(referenced)) continue;
          if (typeof referenced !== "string") {
            bag.error(CODES.NATIVE_LOWERING, `input ${inputName} of ${id} has invalid shadow`);
            continue;
          }
          const shadow = findBlock(project, referenced);
          if (!shadow || !shadow.shadow) {
            bag.error(CODES.NATIVE_LOWERING, `input ${inputName} of ${id} references a non-shadow block`);
          } else if (shadow.parent !== id) {
            bag.error(CODES.NATIVE_LOWERING, `shadow ${referenced} has wrong parent`);
          }
          continue;
        }
        if (input[0] === 3) {
          const hidden = input[2];
          if (!Array.isArray(hidden)) {
            bag.error(CODES.NATIVE_LOWERING, `input ${inputName} of ${id} is missing its hidden shadow`);
          }
          if (Array.isArray(referenced)) continue;
        }
        if (typeof referenced !== "string") continue;
        const child = findBlock(project, referenced);
        if (!child) {
          bag.error(CODES.NATIVE_LOWERING, `input ${inputName} of ${id} references missing block ${referenced}`);
        } else if (child.parent !== id) {
          bag.error(CODES.NATIVE_LOWERING, `input ${inputName} of ${id} references block with wrong parent`);
        }
      }
    }
  }
  for (const extensionId of project.extensions) {
    if (!/^[a-z0-9-]+$/i.test(extensionId)) {
      bag.error(CODES.NATIVE_LOWERING, `invalid extension id ${extensionId}`);
    }
    if (!project.extensionURLs[extensionId]) {
      bag.error(CODES.NATIVE_LOWERING, `extension ${extensionId} is declared but has no extensionURLs entry`);
    }
  }
  if (project.meta.semver !== "3.0.0") {
    bag.error(CODES.NATIVE_LOWERING, `unexpected project semver ${project.meta.semver}`);
  }
}

export { findBlock };
