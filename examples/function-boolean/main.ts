import { Scratch } from "@typescratch/runtime";

function choose(flag: boolean): number {
  if (flag) {
    return 1;
  }
  return 0;
}

Scratch.onFlag(() => {
  Scratch.say(choose(true));
  Scratch.say(choose(false));
});
