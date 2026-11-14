import type { ExtensionBundle } from "@typescratch/backend-turbowarp";

export interface OutputFile {
  filename: string;
  contents: string | Uint8Array;
}

export interface AssembleOptions {
  sb3: Uint8Array;
  sb3Filename: string;
  projectJson: string;
  report: unknown;
  sourceMap: unknown;
  bundle?: ExtensionBundle;
}

export function assembleOutputs(options: AssembleOptions): OutputFile[] {
  const stem = options.sb3Filename.replace(/\.sb3$/, "");
  const files: OutputFile[] = [
    { filename: options.sb3Filename, contents: options.sb3 },
    { filename: `${stem}.project.json`, contents: options.projectJson },
    { filename: `${stem}.report.json`, contents: JSON.stringify(options.report, null, 2) },
    { filename: `${stem}.source-map.json`, contents: JSON.stringify(options.sourceMap, null, 2) },
  ];
  if (options.bundle) {
    files.push({ filename: options.bundle.filename, contents: options.bundle.code });
    files.push({
      filename: `${stem}.turbowarp.json`,
      contents: JSON.stringify(options.bundle.manifest, null, 2),
    });
  }
  return files;
}
