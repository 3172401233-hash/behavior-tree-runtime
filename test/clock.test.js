import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/index.js';

test('virtual clock only advances when caller drives it', () => {
  const clock = new VirtualClock();
  const fired = [];
  clock.schedule(10, () => fired.push(clock.now()));
  clock.schedule(5, () => fired.push(clock.now()));
  assert.equal(clock.now(), 0);
  clock.advance(4);
  assert.deepEqual(fired, []);
  clock.advance(6);
  assert.deepEqual(fired, [5, 10]);
});

test('timers scheduled for the same instant fire in registration order', () => {
  const clock = new VirtualClock();
  const order = [];
  clock.schedule(3, () => order.push('a'));
  clock.schedule(3, () => order.push('b'));
  clock.advance(3);
  assert.deepEqual(order, ['a', 'b']);
});

test('cancelled timers never fire', () => {
  const clock = new VirtualClock();
  let hits = 0;
  const handle = clock.schedule(5, () => hits++);
  clock.cancel(handle);
  clock.advance(10);
  assert.equal(hits, 0);
  assert.equal(clock.pending().length, 0);
});

test('clock cannot move backwards', () => {
  const clock = new VirtualClock();
  clock.advance(5);
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.set(4), RangeError);
});
