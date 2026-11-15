import { Scratch } from "@typescratch/runtime";

function add(a: number, b: number): number {
  return a + b;
}

function classify(x: number): number {
  if (x > 10) {
    return 1;
  }
  return add(x, 5);
}

Scratch.onFlag(() => {
  Scratch.say(classify(20));
  Scratch.say(classify(3));
});
