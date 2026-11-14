import { Scratch } from "@typescratch/runtime";

Scratch.onKey("not-a-key", () => {
  Scratch.say("never");
});
