import { Scratch } from "@typescratch/runtime";

const flag = Scratch.local<boolean>("flag", { initial: false });

Scratch.onFlag(() => {
  flag.set(true);
});
