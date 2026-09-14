import { expect, test, vi } from 'vitest';
import { createCanvasUiLocaleState } from './canvas-ui-locale';

test('eager and delayed Canvas controls observe the latest interface locale', () => {
  const state = createCanvasUiLocaleState();
  const eager = vi.fn();
  const stop = state.subscribe(eager);

  expect(eager).toHaveBeenLastCalledWith('en');
  expect(state.set('de')).toBe(true);
  expect(eager).toHaveBeenLastCalledWith('de');

  const delayed = vi.fn();
  state.subscribe(delayed);
  expect(delayed).toHaveBeenCalledOnce();
  expect(delayed).toHaveBeenLastCalledWith('de');
  expect(state.set('de')).toBe(false);

  stop();
  state.set('en');
  expect(eager).toHaveBeenCalledTimes(2);
  expect(delayed).toHaveBeenLastCalledWith('en');
});
