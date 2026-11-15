export interface Handle<T> {
  get(): T;
  set(value: T): void;
  change(delta: T): void;
}

export interface ListHandle<T> {
  push(value: T): void;
  insert(index: number, value: T): void;
  replace(index: number, value: T): void;
  deleteAt(index: number): void;
  clear(): void;
  item(index: number): T;
  length(): number;
}

/** A heap-allocated array. Unlike ListHandle, two handles can alias the same ObjectRef. */
export interface ArrayHandle<T> {
  get(index: number): T;
  set(index: number, value: T): void;
  length(): number;
}

export interface ResourceOptions<T> {
  initial?: T;
}

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type Letter =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

export type KeyName =
  | "any" | "space" | "up arrow" | "down arrow" | "left arrow" | "right arrow"
  | Letter | Digit;

export declare const Scratch: {
  onFlag(handler: () => void): void;
  onKey(key: KeyName, handler: () => void): void;
  onSpriteClicked(handler: () => void): void;
  onClone(handler: () => void): void;
  onBackdrop(backdrop: string, handler: () => void): void;
  onBroadcast(name: string, handler: () => void): void;
  onGreaterThan(sensor: "timer" | "loudness", value: number, handler: () => void): void;
  say(message: string | number | boolean): void;
  wait(seconds: number): void;
  move(steps: number): void;
  hide(): void;
  show(): void;
  global<T>(name: string, options?: ResourceOptions<T>): Handle<T>;
  local<T>(name: string, options?: ResourceOptions<T>): Handle<T>;
  list<T>(name: string): ListHandle<T>;
  array<T>(size: number): ArrayHandle<T>;
  free(ref: unknown): void;
};
