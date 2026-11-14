import type { BackendPlan, ExtensionRegion } from "@typescratch/backend-planner";

export interface ExtensionManifest {
  schema: 1;
  target: "turbowarp";
  project: string;
  extension: {
    id: string;
    file: string;
    sandbox: "sandboxed";
    opcodes: string[];
    boundaryCalls: number;
    loadCost: string;
  };
  embedding: {
    projectJsonField: "extensionURLs";
    key: string;
    urlFormat: "data:application/javascript;base64,...";
    note: string;
  };
  compatibility: {
    officialScratch: false;
    uploadToScratchWebsite: false;
    reason: string;
  };
}

export interface ExtensionBundle {
  id: string;
  filename: string;
  code: string;
  dataUrl: string;
  manifest: ExtensionManifest;
}

function blockSource(region: ExtensionRegion): string {
  const args = region.spec.arguments
    .map((argument) => `${argument.name}: { type: Scratch.ArgumentType.${argument.type} }`)
    .join(", ");
  return [
    "          {",
    `            opcode: ${JSON.stringify(region.spec.opcode)},`,
    `            blockType: Scratch.BlockType.${region.spec.blockType},`,
    `            text: ${JSON.stringify(region.spec.text)},`,
    `            arguments: { ${args} }`,
    "          }",
  ].join("\n");
}

function handlerSource(region: ExtensionRegion): string {
  const names = region.spec.arguments.map((argument) => argument.name);
  const declarations = names
    .map((name) => region.spec.guard === "number"
      ? `const ${name} = Number(args.${name});`
      : `const ${name} = String(args.${name});`)
    .join("\n        ");
  const validation = region.spec.guard === "number"
    ? `if (![${names.join(", ")}].every(Number.isFinite)) return 0;`
    : "";
  const fallback = region.spec.returns === "number" ? "0" : '""';
  return [
    `    ${region.spec.opcode}(args) {`,
    "      try {",
    `        ${declarations}`,
    validation ? `        ${validation}` : "",
    `        return ${region.spec.build(names)};`,
    "      } catch {",
    `        return ${fallback};`,
    "      }",
    "    }",
  ].filter((line) => line !== "").join("\n");
}

export function generateExtension(
  plan: BackendPlan,
  sb3Filename: string,
): ExtensionBundle | undefined {
  if (!plan.extensionId || plan.regions.length === 0) return undefined;
  const id = plan.extensionId;
  const filename = `extensions/${id}.js`;
  const code = [
    "(function (Scratch) {",
    "  'use strict';",
    "  class TypeScratchGenerated {",
    "    getInfo() {",
    "      return {",
    `        id: ${JSON.stringify(id)},`,
    "        name: 'TypeScratch generated',",
    "        blocks: [",
    plan.regions.map(blockSource).join(",\n"),
    "        ]",
    "      };",
    "    }",
    plan.regions.map(handlerSource).join("\n"),
    "  }",
    "  Scratch.extensions.register(new TypeScratchGenerated());",
    "})(Scratch);",
    "",
  ].join("\n");
  const dataUrl = `data:application/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;

  const manifest: ExtensionManifest = {
    schema: 1,
    target: "turbowarp",
    project: sb3Filename,
    extension: {
      id,
      file: filename,
      sandbox: "sandboxed",
      opcodes: plan.regions.map((region) => `${id}_${region.spec.opcode}`),
      boundaryCalls: plan.boundaryCalls,
      loadCost: "Sandboxed extension calls cost at least one VM frame each.",
    },
    embedding: {
      projectJsonField: "extensionURLs",
      key: id,
      urlFormat: "data:application/javascript;base64,...",
      note: "TurboWarp reads project.json.extensionURLs, resolves the extension ID from the block opcode prefix, and loads the data: URL automatically. The standalone .js file is provided for inspection only.",
    },
    compatibility: {
      officialScratch: false,
      uploadToScratchWebsite: false,
      reason: "Custom extension projects cannot be uploaded to the official Scratch website.",
    },
  };

  return { id, filename, code, dataUrl, manifest };
}
