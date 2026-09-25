import { flushSync } from 'svelte';

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Not svelte's tick: importing it into ui test files has reddened unrelated tests.
export const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

export const q = <T extends Element>(sel: string) => {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} missing`);
  return el;
};
