import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BehaviorTree,
  Sequence,
  Selector,
  Parallel,
  Condition,
  Branch,
  Cooldown,
  Action,
  Status,
} from '../src/index.js';

const syncAction = (id, status, log) =>
  new Action({
    id,
    start: () => {
      log.push(id);
      return status;
    },
  });

test('sequence stops on first failure and resumes a running child once', () => {
  const log = [];
  const async = new Action({
    id: 'async',
    start: () => Status.RUNNING,
  });
  const tree = new BehaviorTree(
    new Sequence({
      id: 'seq',
      children: [syncAction('a', Status.SUCCESS, log), async, syncAction('c', Status.SUCCESS, log)],
    }),
  );
  assert.equal(tree.tick(), Status.RUNNING);
  assert.deepEqual(log, ['a']);
  tree.invocations.forEach((inv) => tree._completeInvocation(inv.id, Status.SUCCESS));
  assert.equal(tree.tick(), Status.SUCCESS);
  assert.deepEqual(log, ['a', 'c']);
});

test('selector succeeds on first success and fails through', () => {
  const log = [];
  const tree = new BehaviorTree(
    new Selector({
      id: 'sel',
      children: [
        syncAction('a', Status.FAILURE, log),
        syncAction('b', Status.SUCCESS, log),
        syncAction('c', Status.SUCCESS, log),
      ],
    }),
  );
  assert.equal(tree.tick(), Status.SUCCESS);
  assert.deepEqual(log, ['a', 'b']);
});

test('parallel: one failure aborts the still-running branch (any/all defaults)', () => {
  const cancelled = [];
  const longAction = new Action({
    id: 'long',
    start: () => Status.RUNNING,
    onCancel: () => cancelled.push('long'),
  });
  const tree = new BehaviorTree(
    new Parallel({
      id: 'par',
      children: [longAction, syncAction('fail', Status.FAILURE, [])],
    }),
  );
  assert.equal(tree.tick(), Status.FAILURE);
  assert.deepEqual(cancelled, ['long']);
  assert.deepEqual(tree.activeNodeIds(), []);
});

test('parallel with success any: one success cancels the other branch', () => {
  const cancelled = [];
  const tree = new BehaviorTree(
    new Parallel({
      id: 'par2',
      successPolicy: 'any',
      failurePolicy: 'all',
      children: [
        syncAction('ok', Status.SUCCESS, []),
        new Action({
          id: 'running',
          start: () => Status.RUNNING,
          onCancel: () => cancelled.push('running'),
        }),
      ],
    }),
  );
  assert.equal(tree.tick(), Status.SUCCESS);
  assert.deepEqual(cancelled, ['running']);
});

test('condition and branch route by predicate', () => {
  const tree = new BehaviorTree(
    new Branch({
      id: 'branch',
      predicate: (ctx) => ctx.blackboard.read('mode') === 'attack',
      then: syncAction('attack', Status.SUCCESS, []),
      else: syncAction('idle', Status.SUCCESS, []),
    }),
  );
  tree.blackboard.write('mode', 'defend');
  assert.equal(tree.tick(), Status.SUCCESS);
  assert.equal(tree.nodes.get('attack').activeInvocationId, null);
  tree.blackboard.write('mode', 'attack');
  assert.equal(tree.tick(), Status.SUCCESS);
});

test('cooldown blocks re-entry until virtual time advances', () => {
  const runs = [];
  const tree = new BehaviorTree(
    new Cooldown({
      id: 'cool',
      durationMs: 100,
      child: syncAction('pulse', Status.SUCCESS, runs),
    }),
  );
  assert.equal(tree.tick(), Status.SUCCESS);
  assert.equal(tree.tick(), Status.FAILURE);
  tree.clock.advance(99);
  assert.equal(tree.tick(), Status.FAILURE);
  tree.clock.advance(1);
  assert.equal(tree.tick(), Status.SUCCESS);
  assert.deepEqual(runs, ['pulse', 'pulse']);
});

test('action completed in the event phase lets its sequence advance in the same tick', () => {
  let secondStarts = 0;
  const first = new Action({
    id: 'event-driven',
    start: () => Status.RUNNING,
    events: { go: (ctx) => ctx.finish(Status.SUCCESS) },
    onCancel: () => {},
  });
  const second = new Action({
    id: 'after',
    start: () => {
      secondStarts += 1;
      return Status.SUCCESS;
    },
  });
  const tree = new BehaviorTree(
    new Sequence({ id: 'seq', children: [first, second] }),
  );
  assert.equal(tree.tick(), Status.RUNNING);
  tree.queueEvent({ type: 'go' });
  assert.equal(tree.tick(), Status.SUCCESS);
  assert.equal(secondStarts, 1);
  assert.equal(tree.nodes.get('event-driven').activeInvocationId, null);
});
