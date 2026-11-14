import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BehaviorTree,
  Sequence,
  Selector,
  Cooldown,
  Action,
  Status,
} from '../src/index.js';

function buildTree() {
  const worker = new Action({
    id: 'worker',
    events: {
      __timer__: (ctx, event) => {
        if (event.tag === 'finish') ctx.finish(Status.SUCCESS);
      },
    },
    start: (ctx) => {
      ctx.set('step', 1);
      ctx.wait(30, { kind: 'payload' }, 'finish');
      return Status.RUNNING;
    },
    onCancel: () => {},
  });
  const tree = new BehaviorTree(
    new Sequence({
      id: 'root',
      children: [
        new Cooldown({ id: 'cool', durationMs: 100, child: worker }),
      ],
    }),
    { treeVersion: 1 },
  );
  tree.blackboard.write('globalKey', 'v1');
  return tree;
}

test('snapshot captures active node, wait conditions, blackboard and cooldown, then restores', () => {
  const tree = buildTree();
  tree.tick({ advanceMs: 10 });
  const snapshot = tree.snapshot();

  assert.equal(snapshot.schemaVersion, 2);
  assert.ok(snapshot.nodeStates.worker.invocationId);
  assert.deepEqual(snapshot.invocations[0].events, ['__timer__']);
  assert.equal(snapshot.invocations[0].timers[0].runAt, 40);
  assert.equal(snapshot.blackboard.root.globalKey, 'v1');
  assert.equal(snapshot.blackboard.scopes[0].values.step, 1);
  // 动作尚未成功，冷却未启动
  assert.equal(snapshot.nodeStates.cool.readyAt, null);
  assert.equal(snapshot.clock, 10);

  const restored = buildTree();
  restored.restore(snapshot);
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.deepEqual(restored.activeNodeIds(), ['worker']);
  assert.equal(restored.clock.now(), 10);

  // 恢复后等待条件继续有效：推进到 t=40，定时器触发完成动作，
  // 成功后冷却启动，装饰器立即返回成功；下一次 tick 冷却拦截返回失败。
  assert.equal(restored.tick({ advanceMs: 30 }), Status.SUCCESS);
  assert.equal(restored.invocations.size, 0);
  assert.equal(restored.blackboard.read('step'), 1);
  assert.equal(restored.nodes.get('cool').remainingMs(restored.clock.now()), 100);
  assert.equal(restored.tick(), Status.FAILURE);
});

test('restored tree rejects a mismatched treeVersion', () => {
  const tree = buildTree();
  tree.tick();
  const snapshot = tree.snapshot();
  const other = buildTree();
  other.treeVersion = 2;
  assert.throws(() => other.restore(snapshot), /tree version mismatch/);
});

test('node declaration order changes do not break restore when stable ids are used', () => {
  const actionA = new Action({ id: 'a', start: () => Status.RUNNING, onCancel: () => {} });
  const actionB = new Action({ id: 'b', start: () => Status.SUCCESS });
  const original = new BehaviorTree(
    new Selector({ id: 'sel', children: [actionA, actionB] }),
  );
  original.tick();
  const snapshot = original.snapshot();

  // 重建树时交换两个子节点的声明顺序
  const reorderedA = new Action({ id: 'a', start: () => Status.RUNNING, onCancel: () => {} });
  const reorderedB = new Action({ id: 'b', start: () => Status.SUCCESS });
  const reordered = new BehaviorTree(
    new Selector({ id: 'sel', children: [reorderedB, reorderedA] }),
  );
  reordered.restore(snapshot);
  assert.equal(reordered.nodes.get('a').activeInvocationId, actionA.activeInvocationId);
  assert.deepEqual(reordered.activeNodeIds(), ['a']);
});

test('v1 snapshots migrate: cooldown remainingMs becomes readyAt', () => {
  const v1 = {
    schemaVersion: 1,
    treeVersion: 1,
    tick: 3,
    invocationSeq: 1,
    clock: 50,
    timers: [],
    blackboard: { root: {}, scopes: [] },
    nodeStates: {},
    cooldowns: { cool: { remainingMs: 25 } },
    invocations: [],
    eventQueue: [],
  };
  const tree = buildTree();
  tree.restore(v1);
  assert.equal(tree.nodes.get('cool').readyAt, 75);
  assert.equal(tree.nodes.get('cool').remainingMs(50), 25);
  assert.equal(tree.snapshot().schemaVersion, 2);
});

test('unknown node id in snapshot fails loudly instead of binding to the wrong node', () => {
  const tree = buildTree();
  tree.tick();
  const snapshot = tree.snapshot();
  snapshot.nodeStates.ghost = { index: 0 };
  assert.throws(() => buildTree().restore(snapshot), /unknown node id: ghost/);
});
