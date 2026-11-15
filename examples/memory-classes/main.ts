import { Scratch } from "@typescratch/runtime";

class Player {
  x: number = 1;
  label: string = "player";

  step(n: number): number {
    this.x = this.x + n;
    return this.x;
  }
}

class Enemy {
  x: number = 100;
  label: string = "enemy";

  step(n: number): number {
    this.x = this.x - n;
    return this.x;
  }
}

Scratch.onFlag(() => {
  const p = new Player();
  const e = new Enemy();
  Scratch.say(p.x);
  Scratch.say(e.x);
  Scratch.say(p.label);
  Scratch.say(e.label);
  Scratch.say(p.step(2));
  Scratch.say(e.step(2));
  Scratch.say(p.x);
  Scratch.say(e.x);
});
