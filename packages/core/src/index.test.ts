import { expect, test } from 'vitest';
import { name } from './index.js';

test('package exports its name', () => {
  expect(name).toBe('@handover/core');
});
