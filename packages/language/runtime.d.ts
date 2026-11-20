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

/**
 * A dictionary backed by parallel Scratch lists with a linear-scan lookup
 * (O(n), not O(1)). `get(k)` returns the type's zero value when k is absent —
 * call `has(k)` first if that matters. Keys are numbers in v1; string keys are
 * rejected because Scratch's native `operator_equals` is case-insensitive and
 * would silently conflate "A" and "a".
 */
export interface MapHandle<K, V> {
  set(key: K, value: V): void;
  get(key: K): V;
  has(key: K): boolean;
  delete(key: K): void;
  size(): number;
  clear(): void;
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

/**
 * Compile-time storage decorators for top-level variables. By default a
 * top-level `let` is private to its sprite; @global makes it a Stage variable
 * visible to every role in a workspace. No runtime behavior.
 */
export declare function global(target: object, propertyKey?: string | symbol): void;
export declare function local(target: object, propertyKey?: string | symbol): void;

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
  /** Create a dictionary. Key type must be `number` in v1. */
  map<K extends number, V>(): MapHandle<K, V>;
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
  /** Object-call Scratch blocks. Metadata lives here (param names = Scratch inputs, JSDoc = opcode/field, return type = command vs reporter). */
  readonly looks: {
    /** @tscr opcode looks_say */
    say(MESSAGE: string): void;
    /** @tscr opcode looks_sayforsecs */
    sayForSecs(MESSAGE: string, SECS: number): void;
    /** @tscr opcode looks_think */
    think(MESSAGE: string): void;
    /** @tscr opcode looks_thinkforsecs */
    thinkForSecs(MESSAGE: string, SECS: number): void;
    /** @tscr opcode looks_show */
    show(): void;
    /** @tscr opcode looks_hide */
    hide(): void;
    /** @tscr opcode looks_nextcostume */
    nextCostume(): void;
    /** @tscr opcode looks_nextbackdrop */
    nextBackdrop(): void;
    /** @tscr opcode looks_setsizeto */
    setSizeTo(SIZE: number): void;
    /** @tscr opcode looks_changesizeby */
    changeSizeBy(CHANGE: number): void;
    /** @tscr opcode looks_cleargraphiceffects */
    clearGraphicEffects(): void;
    /** @tscr opcode looks_gotofrontback */
    goToFrontBack(/** @tscr field */ FRONT_BACK: string): void;
    /** @tscr opcode looks_goforwardbackwardlayers */
    goForwardBackwardLayers(NUM: number, /** @tscr field */ FORWARD_BACKWARD: string): void;
    /** @tscr opcode looks_switchcostumeto */
    switchCostumeTo(COSTUME: string): void;
    /** @tscr opcode looks_switchbackdropto */
    switchBackdropTo(BACKDROP: string): void;
    /** @tscr opcode looks_size */
    size(): number;
    /** @tscr opcode looks_costumenumbername */
    costumeNumberName(/** @tscr field */ NUMBER_NAME: string): string;
    /** @tscr opcode looks_backdropnumbername */
    backdropNumberName(/** @tscr field */ NUMBER_NAME: string): string;
  };
  readonly motion: {
    /** @tscr opcode motion_movesteps */
    moveSteps(STEPS: number): void;
    /** @tscr opcode motion_turnright */
    turnRight(DEGREES: number): void;
    /** @tscr opcode motion_turnleft */
    turnLeft(DEGREES: number): void;
    /** @tscr opcode motion_gotoxy */
    goToXY(X: number, Y: number): void;
    /** @tscr opcode motion_glidesecstoxy */
    glideSecsToXY(SECS: number, X: number, Y: number): void;
    /** @tscr opcode motion_setx */
    setX(X: number): void;
    /** @tscr opcode motion_sety */
    setY(Y: number): void;
    /** @tscr opcode motion_changexby */
    changeXBy(DX: number): void;
    /** @tscr opcode motion_changeyby */
    changeYBy(DY: number): void;
    /** @tscr opcode motion_pointindirection */
    pointInDirection(DIRECTION: number): void;
    /** @tscr opcode motion_setrotationstyle */
    setRotationStyle(/** @tscr field */ STYLE: string): void;
    /** @tscr opcode motion_ifonedgebounce */
    ifOnEdgeBounce(): void;
    /** @tscr opcode motion_xposition */
    xPosition(): number;
    /** @tscr opcode motion_yposition */
    yPosition(): number;
    /** @tscr opcode motion_direction */
    direction(): number;
  };
  // Operators are TypeScript syntax (+ - * / == etc.) — no object namespace.
  readonly sensing: {
    /** @tscr opcode sensing_resettimer */
    resetTimer(): void;
    /** @tscr opcode sensing_setdragmode */
    setDragMode(/** @tscr field */ DRAG_MODE: string): void;
    /** @tscr opcode sensing_askandwait */
    askAndWait(QUESTION: string): void;
    /** @tscr opcode sensing_touchingobject */
    touchingObject(/** @tscr field */ TOUCHINGOBJECTMENU: string): boolean;
    /** @tscr opcode sensing_mousedown */
    mouseDown(): boolean;
    /** @tscr opcode sensing_keypressed */
    keyPressed(/** @tscr field */ KEY_OPTION: string): boolean;
    /** @tscr opcode sensing_timer */
    timer(): number;
    /** @tscr opcode sensing_mousex */
    mouseX(): number;
    /** @tscr opcode sensing_mousey */
    mouseY(): number;
    /** @tscr opcode sensing_answer */
    answer(): string;
    /** @tscr opcode sensing_username */
    username(): string;
  };
  readonly sound: {
    /** @tscr opcode sound_play */
    play(/** @tscr field */ SOUND_MENU: string): void;
    /** @tscr opcode sound_playuntildone */
    playUntilDone(/** @tscr field */ SOUND_MENU: string): void;
    /** @tscr opcode sound_stopallsounds */
    stopAllSounds(): void;
    /** @tscr opcode sound_cleareffects */
    clearSoundEffects(): void;
    /** @tscr opcode sound_setvolumeto */
    setVolumeTo(VOLUME: number): void;
    /** @tscr opcode sound_changevolumeby */
    changeVolumeBy(VOLUME: number): void;
    /** @tscr opcode sound_volume */
    volume(): number;
  };
};
