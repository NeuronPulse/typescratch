import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  const forever = true;
  while (forever) {
    Scratch.wait(0.1);
    break;
  }
});
