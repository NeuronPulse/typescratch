import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  let i = 0;
  while (i < 8) {
    i++;
    if (i === 5) {
      break;
    }
  }
  Scratch.say(`A${i}`);
});

Scratch.onKey("space", () => {
  let j = 0;
  while (j < 8) {
    j++;
    if (j === 3) {
      break;
    }
  }
  Scratch.say(`B${j}`);
});
