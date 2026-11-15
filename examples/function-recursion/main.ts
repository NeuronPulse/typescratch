import { Scratch } from "@typescratch/runtime";

function loop(n: number): number {
  return loop(n + 1);
}

Scratch.onFlag(() => {
  Scratch.say(loop(1));
});
