export interface SourceSpan {
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  span?: SourceSpan;
  details?: string[];
}

export const CODES = {
  TS_TYPE: "TSCR1001",
  UNSUPPORTED: "TSCR2001",
  UNKNOWN_API: "TSCR2002",
  UNSAFE_SEMANTICS: "TSCR2003",
  NATIVE_LOWERING: "TSCR3001",
  RECURSION: "TSCR3002",
  WARP_DECORATOR: "TSCR3003",
  WARP_ABI: "TSCR3004",
  WARP_YIELD: "TSCR3005",
  DECORATOR: "TSCR2010",
  ABI: "TSCR4001",
  YIELD: "TSCR4002",
  VARIABLE_TYPE: "TSCR4003",
  VARIABLE_SCOPE: "TSCR4004",
  NUMERIC_PROFILE: "TSCR4005",
  COMPAT: "TSCR5001",
  PERF: "TSCR6001",
} as const;

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  add(item: Diagnostic): void {
    this.items.push(item);
  }

  error(code: string, message: string, span?: SourceSpan, details?: string[]): void {
    this.add({ code, severity: "error", message, span, details });
  }

  warning(code: string, message: string, span?: SourceSpan, details?: string[]): void {
    this.add({ code, severity: "warning", message, span, details });
  }

  info(code: string, message: string, span?: SourceSpan, details?: string[]): void {
    this.add({ code, severity: "info", message, span, details });
  }

  merge(other: DiagnosticBag): void {
    this.items.push(...other.items);
  }

  get hasErrors(): boolean {
    return this.items.some((item) => item.severity === "error");
  }
}

export function formatDiagnostic(item: Diagnostic): string {
  const where = item.span
    ? `${item.span.file}:${item.span.line}:${item.span.column}`
    : "<project>";
  const lines = [`${item.code} ${item.severity} ${where}`, `  ${item.message}`];
  for (const detail of item.details ?? []) lines.push(`  ${detail}`);
  return lines.join("\n");
}
