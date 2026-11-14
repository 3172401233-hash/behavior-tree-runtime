import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BehaviorTree,
  Sequence,
  Parallel,
  Action,
  Status,
} from '../src/index.js';

test('multi-frame action finishes through a clock-driven wait', () => {
  const tree = new BehaviorTree(
    new Action({
      id: 'worker',
      events: {
        __timer__: (ctx, event) => {
          if (event.tag === 'done') ctx.finish(Status.SUCCESS);
        },
      },
      start: (ctx) => {
        ctx.set('progress', 'started');
        ctx.wait(20, null, 'done');
        return Status.RUNNING;
      },
    }),
  );
  assert.equal(tree.tick(), Status.RUNNING);
  assert.equal(tree.blackboard.read('progress', 'inv_1'), 'started');
  assert.equal(tree.tick({ advanceMs: 19 }), Status.RUNNING);
  assert.equal(tree.tick({ advanceMs: 1 }), Status.SUCCESS);
  // commit 后局部写入进入 root，局部层消失
  assert.equal(tree.blackboard.read('progress'), 'started');
  assert.deepEqual(tree.blackboard.activeScopeNames(), []);
  assert.equal(tree.clock.pending().length, 0);
});

test('cancellation rolls back blackboard writes and removes timers and invocations', () => {
  const cleanupCalls = [];
  let waitDuringCancel = null;
  const longAction = new Action({
    id: 'chase',
    events: {
      __timer__: (ctx) => ctx.finish(Status.SUCCESS),
    },
    start: (ctx) => {
      ctx.set('path', [[0, 0], [1, 1]]);
      ctx.setGlobal('chasing', true);
      ctx.wait(50, null, 'timeout');
      return Status.RUNNING;
    },
    onCancel: (ctx) => {
      cleanupCalls.push(ctx.invocationId);
      // 清理钩子里尝试写黑板/注册新回调：写入仍会被回滚，wait 被拒绝
      ctx.set('path', 'cancelling');
      try {
        ctx.wait(10);
      } catch (error) {
        waitDuringCancel = error;
      }
    },
  });
  const tree = new BehaviorTree(
    new Sequence({ id: 'root', children: [longAction] }),
  );
  tree.tick();
  const invocationId = longAction.activeInvocationId;
  assert.ok(invocationId);
  tree.root.abort();

  assert.deepEqual(cleanupCalls, [invocationId]);
  assert.ok(waitDuringCancel instanceof Error);
  assert.equal(tree.invocations.size, 0);
  assert.equal(tree.clock.pending().length, 0);
  assert.deepEqual(tree.blackboard.activeScopeNames(), []);
  assert.equal(tree.blackboard.read('path'), undefined);
  assert.equal(tree.blackboard.read('chasing'), undefined);
});

test('cancelled action can be re-entered on a later tick without duplicate starts', () => {
  let starts = 0;
  const action = new Action({
    id: 'reenter',
    start: () => {
      starts += 1;
      return Status.RUNNING;
    },
    onCancel: () => {},
  });
  const tree = new BehaviorTree(action);
  tree.tick();
  tree.root.abort();
  assert.equal(starts, 1);
  assert.equal(tree.tick(), Status.RUNNING);
  assert.equal(starts, 2);
  assert.equal(tree.actionStarts.get('reenter'), 2);
});

test('events are delivered by depth-first action order', () => {
  const seen = [];
  const make = (id) =>
    new Action({
      id,
      events: {
        ping: (ctx, event) => seen.push(`${id}:${event.payload}`),
      },
      start: () => Status.RUNNING,
      onCancel: () => {},
    });
  const tree = new BehaviorTree(
    new Parallel({ id: 'par', children: [make('a'), make('b')] }),
  );
  tree.tick();
  tree.queueEvent({ type: 'ping', payload: 1 });
  tree.tick();
  assert.deepEqual(seen, ['a:1', 'b:1']);
});

test('targeted events for a cancelled invocation are dropped', () => {
  const seen = [];
  const action = new Action({
    id: 'watched',
    events: {
      ping: (ctx, event) => seen.push(event.payload),
    },
    start: () => Status.RUNNING,
    onCancel: () => {},
  });
  const tree = new BehaviorTree(action);
  tree.tick();
  const staleId = action.activeInvocationId;
  tree.queueEvent({ type: 'ping', payload: 'stale', invocationId: staleId });
  tree.root.abort();
  tree.tick();
  assert.deepEqual(seen, []);
});
