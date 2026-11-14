export interface Handle<T> {
  get(): T;
  set(value: T): void;
  change(delta: T): void;
}

export interface ResourceOptions<T> {
  initial?: T;
}

export declare const Scratch: {
  onFlag(handler: () => void): void;
  say(message: string | number | boolean): void;
  wait(seconds: number): void;
  move(steps: number): void;
  hide(): void;
  show(): void;
  global<T>(name: string, options?: ResourceOptions<T>): Handle<T>;
  local<T>(name: string, options?: ResourceOptions<T>): Handle<T>;
};
