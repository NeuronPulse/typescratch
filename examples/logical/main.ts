import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  const a = true;
  const b = false;
  if (a && b) {
    Scratch.say("both");
  } else {
    Scratch.say("not both");
  }
});
