import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  const never = false;
  if (never) {
    Scratch.say("dead");
  } else {
    Scratch.say("alive");
  }
  Scratch.say(1 + 2 * 3);
  Scratch.say("a" + "b");
  let n = 4;
  n = n + 0;
  Scratch.say(n);
  while (never) {
    Scratch.say("never");
  }
});
