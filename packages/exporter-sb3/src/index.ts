import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { CODES, type DiagnosticBag } from "@typescratch/diagnostics";
import type { AssetRef, ProjectGraph, ScratchBlock, Target } from "@typescratch/graph";

interface BuiltModel {
  json: Record<string, unknown>;
  assets: Map<string, Uint8Array>;
}

function blockJson(block: ScratchBlock): Record<string, unknown> {
  const result: Record<string, unknown> = {
    opcode: block.opcode,
    next: block.next,
    parent: block.parent,
    inputs: block.inputs,
    fields: block.fields,
    shadow: block.shadow,
    topLevel: block.topLevel,
  };
  result.x = block.x ?? 0;
  result.y = block.y ?? 0;
  if (block.mutation) result.mutation = block.mutation;
  return result;
}

function buildModel(graph: ProjectGraph, bag: DiagnosticBag): BuiltModel {
  const assets = new Map<string, Uint8Array>();
  const assetJson = (descriptor: AssetRef, extra: Record<string, unknown>): Record<string, unknown> => {
    const content = graph.assets.get(descriptor.assetKey);
    if (content === undefined) {
      bag.error(CODES.NATIVE_LOWERING, `missing asset content for ${descriptor.assetKey}`);
      return {};
    }
    const assetId = createHash("md5").update(content).digest("hex");
    const md5ext = `${assetId}.${descriptor.dataFormat}`;
    assets.set(md5ext, content);
    return { assetId, name: descriptor.name, md5ext, dataFormat: descriptor.dataFormat, ...extra };
  };

  const targets = graph.targets.map((target: Target) => {
    const result: Record<string, unknown> = {
      isStage: target.isStage,
      name: target.name,
      variables: target.variables,
      lists: target.lists,
      broadcasts: target.broadcasts,
      blocks: Object.fromEntries(
        [...target.blocks].map(([id, block]) => [id, blockJson(block)]),
      ),
      comments: target.comments,
      currentCostume: target.currentCostume,
      costumes: target.costumes.map((costume) => assetJson(costume, {
        bitmapResolution: costume.bitmapResolution,
        rotationCenterX: costume.rotationCenterX,
        rotationCenterY: costume.rotationCenterY,
      })),
      sounds: target.sounds.map((sound) => assetJson(sound, {
        rate: sound.rate,
        sampleCount: sound.sampleCount,
      })),
      volume: target.volume,
      layerOrder: target.layerOrder,
    };
    if (target.isStage) {
      result.tempo = target.tempo ?? 60;
      result.videoState = target.videoState ?? "on";
      result.videoTransparency = target.videoTransparency ?? 50;
      result.textToSpeechLanguage = target.textToSpeechLanguage ?? null;
    } else {
      result.visible = target.visible ?? true;
      result.x = target.x ?? 0;
      result.y = target.y ?? 0;
      result.size = target.size ?? 100;
      result.direction = target.direction ?? 90;
      result.draggable = target.draggable ?? false;
      result.rotationStyle = target.rotationStyle ?? "all around";
    }
    return result;
  });

  const json: Record<string, unknown> = {
    targets,
    monitors: [],
    extensions: graph.extensions,
    meta: graph.meta,
  };
  if (Object.keys(graph.extensionURLs).length > 0) {
    json.extensionURLs = graph.extensionURLs;
  }
  return { json, assets };
}

export function buildProjectJson(graph: ProjectGraph, bag: DiagnosticBag): string {
  return JSON.stringify(buildModel(graph, bag).json, null, 2);
}

export function exportSb3(graph: ProjectGraph, bag: DiagnosticBag): Uint8Array {
  const model = buildModel(graph, bag);
  const files: Record<string, Uint8Array> = {
    "project.json": strToU8(JSON.stringify(model.json)),
  };
  for (const [name, content] of model.assets) {
    files[name] = content;
  }
  return zipSync(files, {
    level: 6,
    mtime: new Date("2000-01-01T00:00:00Z"),
  });
}
