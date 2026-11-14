import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  Scratch.say(NaN);
  Scratch.say(-5 % 3);
});
