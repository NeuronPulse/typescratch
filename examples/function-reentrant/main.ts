import { Scratch } from "@typescratch/runtime";

function twice(x: number): number {
  return x * 2;
}

Scratch.onFlag(() => {
  Scratch.say(twice(5));
});

Scratch.onKey("space", () => {
  Scratch.say(twice(7));
});
