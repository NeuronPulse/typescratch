import { Scratch } from "@typescratch/runtime";

Scratch.onFlag(() => {
  const text: string = "1";
  const count: number = 1;
  // Keep TypeScript's static checker quiet while feeding cross-type runtime values
  // through the Value ABI equality path.
  const asNumber = text as unknown as number;
  const two = "2" as unknown as number;
  const three = "3" as unknown as number;
  Scratch.say("" + (asNumber == count));
  Scratch.say("" + (asNumber != count));
  Scratch.say("" + (count == two));
  Scratch.say("" + (count != three));
});
