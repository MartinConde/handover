import { flushSync } from 'svelte';

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Not svelte's tick: importing it into ui test files has reddened unrelated tests.
export const settle = async (turns = 1) => {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};

// Every editor takes the lock on open; any other answer shape reads as somebody else holding it.
export const HELD = { held_by: null, mine: true, expires_at: 1755864120000 };
export const isLock = (url: unknown) => String(url).startsWith('/admin/api/locks/');

export const q = <T extends Element>(sel: string) => {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} missing`);
  return el;
};
