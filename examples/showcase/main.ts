import { Scratch } from "@typescratch/runtime";

const results = Scratch.list<string>("showcase results");
const edgeCount = Scratch.global<number>("edgeCount", { initial: 0 });

function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

class Counter {
  value: number = 0;
  label: string = "counter";

  add(n: number): number {
    this.value = this.value + n;
    return this.value;
  }
}

Scratch.onFlag(() => {
  results.clear();
  const c = new Counter();
  const a = Scratch.array<number>(3);
  c.add(3);
  c.add(4);
  a.set(0, c.value);
  a.set(1, factorial(3));
  a.set(2, a.length());

  let i = 0;
  while (i < 3) {
    i = i + 1;
    if (i === 2) continue;
    results.push("loop " + i);
  }

  results.push("label=" + c.label);
  results.push("counter=" + c.value);
  results.push("factorial=" + factorial(5));
  results.push("array=" + a.get(0) + "," + a.get(1) + "," + a.get(2));
  Scratch.say("C=" + c.value + " F=" + factorial(5) + " A=" + a.get(0) + "," + a.get(1) + "," + a.get(2));
  Scratch.free(a);
  Scratch.free(c);
});

Scratch.onGreaterThan("timer", -1, () => {
  edgeCount.change(1);
});
