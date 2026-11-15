import { Scratch } from "@typescratch/runtime";

Scratch.onGreaterThan("timer", -1, () => {
  Scratch.say("edge fired");
});
