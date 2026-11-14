import { Scratch } from "@typescratch/runtime";

const items = Scratch.list<number>("items");

Scratch.onFlag(() => {
  items.push(7);
  items.push(9);
  Scratch.say(items.length());
  Scratch.say(items.item(0));
  items.insert(1, 8);
  items.replace(2, 11);
  Scratch.say(items.item(2));
  items.deleteAt(0);
  Scratch.say(items.length());
  items.clear();
  Scratch.say(items.length());
});
