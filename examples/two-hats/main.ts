import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  let value = 1;
  value++;
  Scratch.say(`first ${value}`);
});

Scratch.onFlag(() => {
  let value = 10;
  value++;
  Scratch.say(`second ${value}`);
});
