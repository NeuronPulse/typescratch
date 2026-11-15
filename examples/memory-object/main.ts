import { Scratch } from "@typescratch/runtime";

class Player {
  x: number = 1;
  score: number = 0;
  label: string = "P";

  add(delta: number): number {
    this.score = this.score + delta;
    return this.score;
  }

  move(dx: number): number {
    this.x = this.x + dx;
    return this.x;
  }
}

Scratch.onFlag(() => {
  const p = new Player();
  Scratch.say(p.x);
  Scratch.say(p.label);
  p.score = 10;
  Scratch.say(p.score);
  Scratch.say(p.add(5));
  Scratch.say(p.move(3));
  Scratch.say(p.x);
  const a = Scratch.array<number>(3);
  a.set(0, 42);
  a.set(2, 7);
  Scratch.say(a.get(0));
  Scratch.say(a.get(2));
  Scratch.say(a.length());
});
