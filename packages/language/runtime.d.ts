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

/**
 * Compile-time-only method decorators. They mark a method's generated Scratch
 * procedure as warp / non-warp; there is no runtime behavior. TypeScratch
 * rejects @warp under --abi-profile extension and on recursive methods.
 */
export declare function warp(value: unknown, context: unknown): void;
export declare function noWarp(value: unknown, context: unknown): void;

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
  /**
   * Suspend this script until `condition` becomes true. The condition is
   * re-evaluated once per VM step; while false the script is suspended and
   * other scripts may run. The continuation is the VM thread's own stack.
   * Not allowed inside a @warp method (warp procedures never yield).
   */
  waitUntil(condition: boolean): void;
  move(steps: number): void;
  hide(): void;
  show(): void;
  global<T>(name: string, options?: ResourceOptions<T>): Handle<T>;
  local<T>(name: string, options?: ResourceOptions<T>): Handle<T>;
  list<T>(name: string): ListHandle<T>;
  array<T>(size: number): ArrayHandle<T>;
  free(ref: unknown): void;
  /**
   * Generic Scratch block escape hatch. Emits ANY original or extension block
   * by opcode, with named inputs and static menu fields. `do` emits a command;
   * `get` emits a reporter.
   *
   *   Scratch.do("motion_movesteps", { STEPS: 10 });
   *   Scratch.do("motion_goto", {}, { TO: "_random_" });
   *   const x = Scratch.get<number>("sensing_xposition");
   */
  do(opcode: string, inputs?: Record<string, unknown>, fields?: Record<string, string>): void;
  get<T = number>(opcode: string, inputs?: Record<string, unknown>, fields?: Record<string, string>): T;
  /** Object-call syntax for curated Scratch blocks (category.method). */
  readonly motion: {
    moveSteps(a0: number): void;
    turnRight(a0: number): void;
    turnLeft(a0: number): void;
    goToXY(a0: number, a1: number): void;
    glideSecsToXY(a0: number, a1: number, a2: number): void;
    setX(a0: number): void;
    setY(a0: number): void;
    changeXBy(a0: number): void;
    changeYBy(a0: number): void;
    pointInDirection(a0: number): void;
    setRotationStyle(a0: string): void;
    ifOnEdgeBounce(): void;
    xPosition(): number;
    yPosition(): number;
    direction(): number;
  };
  readonly looks: {
    say(a0: string): void;
    sayForSecs(a0: string, a1: number): void;
    think(a0: string): void;
    thinkForSecs(a0: string, a1: number): void;
    show(): void;
    hide(): void;
    nextCostume(): void;
    nextBackdrop(): void;
    setSizeTo(a0: number): void;
    changeSizeBy(a0: number): void;
    clearGraphicEffects(): void;
    goToFrontBack(a0: string): void;
    goForwardBackwardLayers(a0: number, a1: string): void;
    switchCostumeTo(a0: string): void;
    switchBackdropTo(a0: string): void;
    size(): number;
    costumeNumberName(a0: string): string;
    backdropNumberName(a0: string): string;
  };
  readonly sound: {
    play(a0: string): void;
    playUntilDone(a0: string): void;
    stopAllSounds(): void;
    clearSoundEffects(): void;
    setVolumeTo(a0: number): void;
    changeVolumeBy(a0: number): void;
    volume(): number;
  };
  readonly sensing: {
    resetTimer(): void;
    setDragMode(a0: string): void;
    askAndWait(a0: string): void;
    touchingObject(a0: string): boolean;
    mouseDown(): boolean;
    keyPressed(a0: string): boolean;
    timer(): number;
    mouseX(): number;
    mouseY(): number;
    answer(): string;
    username(): string;
  };
  readonly operators: {
    add(a0: number, a1: number): number;
    subtract(a0: number, a1: number): number;
    multiply(a0: number, a1: number): number;
    divide(a0: number, a1: number): number;
    mod(a0: number, a1: number): number;
    random(a0: number, a1: number): number;
    round(a0: number): number;
    join(a0: string, a1: string): string;
    letterOf(a0: number, a1: string): string;
    length(a0: string): number;
    lt(a0: number, a1: number): boolean;
    gt(a0: number, a1: number): boolean;
    equals(a0: string, a1: string): boolean;
    and(a0: boolean, a1: boolean): boolean;
    or(a0: boolean, a1: boolean): boolean;
    not(a0: boolean): boolean;
    contains(a0: string, a1: string): boolean;
  };
};
