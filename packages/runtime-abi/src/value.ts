export type ValueTag = "n" | "s" | "b" | "o" | "u" | "z";
export type ValuePayload = string | number;
export type TaggedValue = readonly [tag: ValueTag, payload: ValuePayload];

export const VALUE_TAGS: readonly ValueTag[] = ["n", "s", "b", "o", "u", "z"];

export interface ObjectRefHandle {
  readonly objectRef: number;
}

export type TaggedInput = string | number | boolean | null | undefined | ObjectRefHandle;

export function objectRef(id: number): ObjectRefHandle {
  return { objectRef: id };
}

export function tag(value: TaggedInput): TaggedValue {
  if (value === null) return ["z", ""];
  if (value === undefined) return ["u", ""];
  switch (typeof value) {
    case "number": return ["n", value];
    case "string": return ["s", value];
    case "boolean": return ["b", value ? 1 : 0];
    case "object": return ["o", value.objectRef];
    default: throw new TypeError(`Value ABI cannot tag ${typeof value}`);
  }
}

export function untag(value: TaggedValue): TaggedInput {
  const [kind, payload] = value;
  switch (kind) {
    case "n": return typeof payload === "number" ? payload : Number(payload);
    case "s": return String(payload);
    case "b": return Number(payload) !== 0;
    case "o": return objectRef(Number(payload));
    case "u": return undefined;
    case "z": return null;
    default: throw new TypeError(`unknown Value ABI tag ${String(kind)}`);
  }
}

export function numberStrictEquals(left: number, right: number): boolean {
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return left === right;
}

export function strictEquals(left: TaggedValue, right: TaggedValue): boolean {
  if (left[0] !== right[0]) return false;
  switch (left[0]) {
    case "n": return numberStrictEquals(Number(left[1]), Number(right[1]));
    case "o": return Number(left[1]) === Number(right[1]);
    case "u":
    case "z": return true;
    default: return left[1] === right[1];
  }
}

export function tsToNumber(value: TaggedValue): number {
  const [kind, payload] = value;
  switch (kind) {
    case "n":
    case "s":
    case "b": return Number(payload);
    case "o":
    case "u": return Number.NaN;
    case "z": return 0;
    default: throw new TypeError(`unknown Value ABI tag ${String(kind)}`);
  }
}

export function tsToString(value: TaggedValue): string {
  const [kind, payload] = value;
  switch (kind) {
    case "n":
    case "s": return String(payload);
    case "b": return Number(payload) === 0 ? "false" : "true";
    case "o": return "[object Object]";
    case "u": return "undefined";
    case "z": return "null";
    default: throw new TypeError(`unknown Value ABI tag ${String(kind)}`);
  }
}

export function tsToBoolean(value: TaggedValue): boolean {
  const [kind, payload] = value;
  switch (kind) {
    case "n": {
      const number = Number(payload);
      return number !== 0 && !Number.isNaN(number);
    }
    case "s": return String(payload).length > 0;
    case "b": return Number(payload) !== 0;
    case "o": return true;
    case "u":
    case "z": return false;
    default: throw new TypeError(`unknown Value ABI tag ${String(kind)}`);
  }
}
