import { Scratch } from "@typescratch/runtime";

const greeting = "compile-time value";

Scratch.onFlag(() => {
  Scratch.say(greeting);
});
