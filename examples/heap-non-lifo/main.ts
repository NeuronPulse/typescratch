import { Scratch } from "@typescratch/runtime";

const results = Scratch.list<string>("non-lifo results");

Scratch.onFlag(() => {
  results.clear();
  const a = Scratch.array<number>(3);
  const b = Scratch.array<number>(2);
  a.set(0, 42);
  b.set(0, 99);
  results.push("before=" + a.get(0) + "," + b.get(0));

  // Release the earlier range first: a LIFO-only allocator would leak it.
  Scratch.free(a);
  Scratch.free(b);

  const c = Scratch.array<number>(2);
  const d = Scratch.array<number>(3);
  results.push("cleared=" + c.get(0) + "," + d.get(0));
  Scratch.say("reused " + d.get(0));

  Scratch.free(c);
  Scratch.free(d);
});
