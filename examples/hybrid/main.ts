import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  Scratch.say(Math.hypot(3, 4));
  Scratch.say("hello".toUpperCase());
  Scratch.say(1 + 1);
});
