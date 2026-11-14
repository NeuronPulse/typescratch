import { Scratch } from "@typescratch/runtime";

Scratch.onKey("space", () => {
  Scratch.say("key");
});

Scratch.onSpriteClicked(() => {
  Scratch.say("clicked");
});

Scratch.onClone(() => {
  Scratch.say("clone");
});

Scratch.onBackdrop("Backdrop1", () => {
  Scratch.say("backdrop");
});

Scratch.onBroadcast("go", () => {
  Scratch.say("broadcast");
});
