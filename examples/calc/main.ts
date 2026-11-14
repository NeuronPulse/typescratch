import { Scratch } from "@typescratch/runtime";

const score = Scratch.global<number>("score", { initial: 9 });

Scratch.onFlag(() => {
  let i = 0;
  while (i < 3) {
    i++;
    if (i % 2 === 0) {
      Scratch.say(`even: ${i}`);
    } else {
      Scratch.say(`odd: ${i}`);
    }
  }
  score.set(Math.sqrt(score.get()));
});
