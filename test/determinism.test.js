import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BehaviorTree,
  Sequence,
  Parallel,
  Selector,
  Action,
  Condition,
  Status,
} from '../src/index.js';

function buildScenario() {
  const makeAction = (id, resultStatus) =>
    new Action({
      id,
      events: {
        go: (ctx, event) => {
          ctx.set('lastEvent', event.payload);
          ctx.finish(resultStatus);
        },
      },
      start: (ctx) => {
        ctx.set('owner', id);
        return Status.RUNNING;
      },
      onCancel: (ctx) => ctx.set('cancelled', id),
    });

  return new BehaviorTree(
    new Sequence({
      id: 'root',
      children: [
        new Condition({ id: 'gate', predicate: (ctx) => ctx.blackboard.read('open') === true }),
        new Parallel({
          id: 'par',
          children: [makeAction('left', Status.SUCCESS), makeAction('right', Status.FAILURE)],
        }),
        new Selector({ id: 'fallback', children: [makeAction('retry', Status.SUCCESS)] }),
      ],
    }),
  );
}

const EVENT_SCRIPT = [
  { advanceMs: 5, events: [{ type: 'go', payload: 1 }] },
  { advanceMs: 10, events: [{ type: 'go', payload: 2 }] },
  { advanceMs: 3, events: [] },
];

function runScript() {
  const tree = buildScenario();
  tree.blackboard.write('open', true);
  const trace = [];
  for (const step of EVENT_SCRIPT) {
    trace.push(tree.tick(step));
  }
  return { trace, snapshot: tree.snapshot(), starts: Object.fromEntries(tree.actionStarts) };
}

test('identical event scripts produce identical traces, snapshots and start counts', () => {
  const a = runScript();
  const b = runScript();
  assert.deepEqual(a.trace, b.trace);
  assert.deepEqual(a.snapshot, b.snapshot);
  assert.deepEqual(a.starts, b.starts);
});

test('parallel branch divergence cancels only the running sibling, once', () => {
  const tree = buildScenario();
  tree.blackboard.write('open', true);
  tree.tick();
  assert.deepEqual(tree.activeNodeIds().sort(), ['left', 'right']);
  tree.queueEvent({ type: 'go', payload: 'x' });
  const status = tree.tick();
  assert.equal(status, Status.FAILURE);
  assert.deepEqual(tree.activeNodeIds(), []);
  assert.equal(tree.invocations.size, 0);
  // 每个动作只启动过一次
  assert.equal(tree.actionStarts.get('left'), 1);
  assert.equal(tree.actionStarts.get('right'), 1);
});

test('runtime sources never use wall-clock or system timers', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const files = readdirSync(srcDir).filter((name) => name.endsWith('.js'));
  const forbidden = [
    /\bsetTimeout\s*\(/,
    /\bsetInterval\s*\(/,
    /\bsetImmediate\s*\(/,
    /\bDate\.now\s*\(/,
    /\bperformance\.now\s*\(/,
  ];
  for (const file of files) {
    const content = readFileSync(path.join(srcDir, file), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(content),
        false,
        `${file} must not call ${pattern}; time only comes from VirtualClock`,
      );
    }
  }
});

test('snapshot round-trip keeps subsequent tick output identical', () => {
  const baseline = buildScenario();
  baseline.blackboard.write('open', true);
  baseline.tick(EVENT_SCRIPT[0]);
  const checkpoint = baseline.snapshot();
  baseline.tick(EVENT_SCRIPT[1]);
  baseline.tick(EVENT_SCRIPT[2]);

  const replayed = buildScenario();
  replayed.blackboard.write('open', true);
  replayed.restore(checkpoint);
  replayed.tick(EVENT_SCRIPT[1]);
  replayed.tick(EVENT_SCRIPT[2]);

  assert.deepEqual(replayed.snapshot(), baseline.snapshot());
});
