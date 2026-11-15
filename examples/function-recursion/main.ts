import { Scratch } from "@typescratch/runtime";

function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

Scratch.onFlag(() => {
  Scratch.say(factorial(5));
});
