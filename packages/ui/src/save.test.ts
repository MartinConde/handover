import { afterEach, expect, test, vi } from 'vitest';
import { flushEntry, type SaveState, saveCoordinator, saveLane } from './save';

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function editor(write: (snapshot: string) => Promise<boolean>, lane = saveLane()) {
  let current = 'opened';
  let state: SaveState = { saved: current, phase: 'idle' };
  const saves = saveCoordinator({
    current: () => current,
    saved: current,
    write,
    lane,
    onstate: (next) => {
      state = next;
    },
  });
  return {
    saves,
    edit: (next: string) => {
      current = next;
    },
    state: () => state,
  };
}

test('a typing burst saves its latest snapshot after two quiet seconds', async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => true);
  const { saves, edit, state } = editor(write);
  saves.change();
  await vi.advanceTimersByTimeAsync(2000);
  expect(write).not.toHaveBeenCalled();
  edit('first');
  saves.change();
  await vi.advanceTimersByTimeAsync(1500);
  edit('latest');
  saves.change();
  await vi.advanceTimersByTimeAsync(1999);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(write.mock.calls).toEqual([['latest']]);
  expect(state()).toEqual({ saved: 'latest', phase: 'idle' });
  expect(saves.unsaved()).toBe(false);
});

test('flush bypasses debounce and joins the outstanding write while draining later edits', async () => {
  vi.useFakeTimers();
  const pending = deferred<boolean>();
  const write = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(true);
  const { saves, edit, state } = editor(write);
  edit('first');
  saves.change();
  const flushed = saves.flush();
  await Promise.resolve();
  expect(state().phase).toBe('saving');
  edit('intermediate');
  saves.change();
  edit('latest');
  expect(saves.flush()).toBe(flushed);
  expect(write.mock.calls).toEqual([['first']]);
  pending.resolve(true);
  expect(await flushed).toBe(true);
  expect(write.mock.calls).toEqual([['first'], ['latest']]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(write).toHaveBeenCalledTimes(2);
  expect(state()).toEqual({ saved: 'latest', phase: 'idle' });
});

for (const rejected of [false, true]) {
  test(`a ${rejected ? 'rejected request' : 'refused write'} retains edits and can retry`, async () => {
    const write = vi.fn();
    if (rejected) write.mockRejectedValueOnce(new Error('Offline'));
    else write.mockResolvedValueOnce(false);
    write.mockResolvedValue(true);
    const { saves, edit, state } = editor(write);
    edit('unsaved words');
    expect(await saves.flush()).toBe(false);
    expect(state()).toEqual({ saved: 'opened', phase: 'failed' });
    expect(saves.unsaved()).toBe(true);
    expect(await saves.flush()).toBe(true);
    expect(state()).toEqual({ saved: 'unsaved words', phase: 'idle' });
  });
}

test('cancelling a pane debounce leaves the edit available to an explicit flush', async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => true);
  const { saves, edit } = editor(write);
  edit('kept');
  const cancel = saves.change();
  cancel();
  await vi.advanceTimersByTimeAsync(3000);
  expect(write).not.toHaveBeenCalled();
  expect(saves.unsaved()).toBe(true);
  expect(await saves.flush()).toBe(true);
  expect(write.mock.calls).toEqual([['kept']]);
});

test('the entry lane serializes languages and reads the latest translation when its turn arrives', async () => {
  const lane = saveLane();
  const pending = deferred<boolean>();
  const source = editor(() => pending.promise, lane);
  const writeTranslation = vi.fn(async () => true);
  const translation = editor(writeTranslation, lane);
  source.edit('source');
  translation.edit('earlier');
  const sourceFlush = source.saves.flush();
  const translationFlush = translation.saves.flush();
  await Promise.resolve();
  expect(writeTranslation).not.toHaveBeenCalled();
  translation.edit('latest');
  pending.resolve(true);
  expect(await sourceFlush).toBe(true);
  expect(await translationFlush).toBe(true);
  expect(writeTranslation.mock.calls).toEqual([['latest']]);
});

test('entry flushing revisits source edits made while a translation is saving', async () => {
  const sourceWrite = vi.fn(async () => true);
  const source = editor(sourceWrite);
  const translation = editor(async () => {
    source.edit('new source');
    return true;
  });
  source.edit('first source');
  translation.edit('translation');
  expect(await flushEntry(source.saves, () => translation.saves)).toBe(true);
  expect(sourceWrite.mock.calls).toEqual([['first source'], ['new source']]);
  expect(source.saves.unsaved() || translation.saves.unsaved()).toBe(false);
});

test('an entry flush stops on a source refusal without writing its translation', async () => {
  const source = editor(async () => false);
  const write = vi.fn(async () => true);
  const translation = editor(write);
  source.edit('source');
  translation.edit('translation');
  expect(await flushEntry(source.saves, () => translation.saves)).toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect(source.saves.unsaved() && translation.saves.unsaved()).toBe(true);
});

test('accepting persisted machine translation does not resave the same snapshot', async () => {
  const write = vi.fn(async () => true);
  const { saves, edit, state } = editor(write);
  edit('translated');
  saves.accept('translated');
  expect(await saves.flush()).toBe(true);
  expect(write).not.toHaveBeenCalled();
  expect(state()).toEqual({ saved: 'translated', phase: 'idle' });
});
