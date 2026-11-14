import { Scratch } from "@typescratch/runtime";

const hp = Scratch.global<number>("hp", { initial: 10 });

Scratch.onFlag(() => {
  let i = 0;
  i++;
  Scratch.say(`hero ${i}`);
  hp.set(i);
});
