import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorTree, Branch, Action, Status } from '../src/index.js';

function buildCombatTree() {
  const makeChase = (id, target) =>
    new Action({
      id,
      events: {
        arrived: (ctx) => ctx.finish(Status.SUCCESS),
        __timer__: (ctx, event) => {
          if (event.tag === 'arrive') ctx.finish(Status.SUCCESS);
        },
      },
      start: (ctx) => {
        ctx.set('engagedTarget', target);
        ctx.wait(100, null, 'arrive');
        return Status.RUNNING;
      },
      onCancel: (ctx) => {
        ctx.set('cancelNotice', target);
      },
    });

  const tree = new BehaviorTree(
    new Branch({
      id: 'targetBranch',
      predicate: (ctx) => ctx.blackboard.read('target') === 'A',
      then: makeChase('chaseA', 'A'),
      else: makeChase('chaseB', 'B'),
    }),
    { treeVersion: 1 },
  );
  tree.blackboard.write('target', 'A');
  return tree;
}

test('target switch and action completion in the same tick leave one consistent state', () => {
  const tree = buildCombatTree();
  assert.equal(tree.tick(), Status.RUNNING);
  const chaseA = tree.nodes.get('chaseA');
  const firstInvocation = chaseA.activeInvocationId;
  assert.ok(firstInvocation);
  assert.equal(tree.invocations.size, 1);

  // 同一 tick：调用方切换目标（黑板），同时旧动作的完成事件入队。
  tree.blackboard.write('target', 'B');
  tree.queueEvent({ type: 'arrived', invocationId: firstInvocation });
  assert.equal(tree.tick(), Status.RUNNING);

  // 旧调用已成功结束并提交，新目标分支的动作只启动一次，不存在重叠调用。
  assert.equal(tree.invocations.size, 1);
  assert.equal(chaseA.activeInvocationId, null);
  assert.equal(tree.actionStarts.get('chaseA'), 1);
  assert.equal(tree.actionStarts.get('chaseB'), 1);
  assert.deepEqual(tree.activeNodeIds(), ['chaseB']);
  // 旧调用成功提交 engagedTarget=A 到 root；新调用的局部层写入 B 并遮蔽读取
  assert.equal(tree.blackboard.read('engagedTarget'), 'B');
  assert.equal(tree.blackboard.read('engagedTarget', tree.nodes.get('chaseB').activeInvocationId), 'B');
  // 同一时刻只有一个活动调用，不存在两个冲突的追击状态
  assert.equal(tree.invocations.size, 1);
  assert.notEqual(tree.nodes.get('chaseB').activeInvocationId, firstInvocation);
});

test('target switch without completion cancels the in-flight chase cleanly', () => {
  const tree = buildCombatTree();
  tree.tick();
  const chaseA = tree.nodes.get('chaseA');
  tree.blackboard.write('target', 'B');
  assert.equal(tree.tick(), Status.RUNNING);

  assert.equal(chaseA.activeInvocationId, null);
  assert.equal(tree.invocations.size, 1);
  assert.equal(tree.clock.pending().length, 1); // 只剩 chaseB 的定时器
  assert.deepEqual(tree.activeNodeIds(), ['chaseB']);
  // chaseA 的局部写入（含 onCancel 内的写入）全部回滚；
  // root 上的 engagedTarget 来自新启动的 chaseB 局部层
  assert.equal(tree.blackboard.read('engagedTarget'), 'B');
  assert.equal(tree.blackboard.read('cancelNotice'), undefined);
  assert.equal(tree.actionStarts.get('chaseA'), 1);
  assert.equal(tree.actionStarts.get('chaseB'), 1);
});

test('timer-driven completion in the switch tick never resurrects the cancelled action', () => {
  const tree = buildCombatTree();
  tree.tick();
  const firstInvocation = tree.nodes.get('chaseA').activeInvocationId;
  tree.blackboard.write('target', 'B');
  // 时钟推进到旧动作定时器到期的同一 tick 再重新评估
  assert.equal(tree.tick({ advanceMs: 100 }), Status.RUNNING);
  assert.equal(tree.invocations.size, 1);
  assert.equal(tree.nodes.get('chaseA').activeInvocationId, null);
  assert.ok(tree.invocations.has(tree.nodes.get('chaseB').activeInvocationId));
  assert.notEqual(tree.nodes.get('chaseB').activeInvocationId, firstInvocation);
});
