import { Scratch } from "@typescratch/runtime";

function double(x: number): number {
  return x * 2;
}

Scratch.onFlag(() => {
  Scratch.say(double(21));
});
