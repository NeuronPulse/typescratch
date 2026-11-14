import { Scratch } from "@typescratch/runtime";

class NotSupported {}

Scratch.onFlag(() => {
  Scratch.say("hi");
});

void NotSupported;
