import type { HatTrigger } from "@typescratch/testing";

export const EVENT_TRIGGERS: HatTrigger[] = [
  { kind: "key", key: "space" },
  { kind: "spriteClicked" },
  { kind: "clone" },
  { kind: "backdrop", name: "Backdrop1" },
  { kind: "broadcast", name: "go" },
];

export const EXPECTED_EVENT_SAYS = ["key", "clicked", "clone", "backdrop", "broadcast"];
