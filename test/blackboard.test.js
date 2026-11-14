import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../src/index.js';

test('invocation scope shadows root and commits on success', () => {
  const board = new Blackboard();
  board.write('target', 'global');
  board.pushScope('inv_1', 'inv_1');
  board.write('target', 'scoped', 'inv_1');
  board.write('local', 1, 'inv_1');
  assert.equal(board.read('target', 'inv_1'), 'scoped');
  board.commitScope('inv_1');
  assert.equal(board.read('target'), 'scoped');
  assert.equal(board.read('local'), 1);
  assert.deepEqual(board.activeScopeNames(), []);
});

test('rollback restores every write including overwrites and deletes', () => {
  const board = new Blackboard();
  board.write('a', 1);
  board.write('b', 2);
  board.pushScope('inv_1', 'inv_1');
  board.write('a', 9, 'inv_1');
  board.write('c', 3, 'inv_1');
  board.delete('b', 'inv_1');
  board.rollbackScope('inv_1');
  assert.equal(board.read('a'), 1);
  assert.equal(board.read('b'), 2);
  assert.equal(board.read('c'), undefined);
  assert.deepEqual(board.activeScopeNames(), []);
});

test('snapshot and restore preserve scopes and values', () => {
  const board = new Blackboard();
  board.write('rootKey', { nested: [1, 2] });
  board.pushScope('inv_7', 'inv_7');
  board.write('tmp', 'x', 'inv_7');
  const restored = Blackboard.restore(board.snapshot());
  assert.deepEqual(restored.read('rootKey'), { nested: [1, 2] });
  assert.equal(restored.read('tmp', 'inv_7'), 'x');
  assert.deepEqual(restored.activeScopeNames(), ['inv_7']);
  // 深克隆保证快照不共享可变引用
  restored.write('rootKey', null);
  assert.deepEqual(board.read('rootKey'), { nested: [1, 2] });
});
