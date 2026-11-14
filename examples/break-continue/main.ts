import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  let i = 0;
  while (i < 6) {
    i++;
    if (i === 2) {
      continue;
    }
    if (i === 5) {
      break;
    }
    Scratch.say(i);
  }
  Scratch.say("done");
});
