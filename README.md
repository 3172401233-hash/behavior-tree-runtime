# behavior-tree-runtime

JavaScript 游戏行为树运行时，处理异步节点、取消传播、黑板作用域和状态恢复。

纯 ESM、零依赖。不内置寻路、网络等真实 IO；时间由调用方通过虚拟时钟推进，
运行时内部不允许出现 `setTimeout` / `setInterval` / `Date.now` 等系统时间 API
（`test/determinism.test.js` 会扫描 `src/` 强制该约束）。

## 快速开始

```js
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
  VirtualClock,
} from './src/index.js';

const chase = new Action({
  id: 'chase',
  // 声明式事件订阅，快照恢复后可据此重新绑定处理器
  events: {
    reached: (ctx) => ctx.finish(Status.SUCCESS),
  },
  start(ctx) {
    ctx.set('engagedTarget', ctx.getGlobal('target'));
    ctx.wait(500, { path: '...' }, 'path-timeout'); // 虚拟延迟，不是系统 timer
    return Status.RUNNING;
  },
  onCancel(ctx) {
    // 释放资源；运行时随后强制注销定时器并回滚黑板
  },
});

const tree = new BehaviorTree(
  new Selector({
    id: 'root',
    children: [
      new Sequence({
        id: 'attack-seq',
        children: [
          new Condition({ id: 'has-target', predicate: (ctx) => !!ctx.blackboard.read('target') }),
          new Cooldown({ id: 'attack-cd', durationMs: 1000, child: chase }),
        ],
      }),
      new Action({ id: 'idle', start: () => Status.SUCCESS }),
    ],
  }),
  { clock: new VirtualClock(), treeVersion: 1 },
);

// 调用方驱动世界：推进时间、投递事件、评估树，全部在一个 tick 内有序完成
tree.blackboard.write('target', nextTarget);
tree.tick({ advanceMs: frameMs, events: [{ type: 'reached' }] });
```

## 节点

- `Sequence`：子节点依次执行，全成功才成功；任一失败即失败，RUNNING 时记忆当前下标。
- `Selector`：依次尝试，任一成功即成功；全失败才失败。
- `Parallel`：每 tick 驱动全部未结束子节点。
  - `successPolicy`：`'all'`（默认）或 `'any'`
  - `failurePolicy`：`'any'`（默认）或 `'all'`
  - 策略达成后，仍在运行的子节点会被级联取消。
- `Condition`：同步谓词，只返回成功/失败。
- `Branch`：谓词为真走 `then`，否则走 `else`；谓词结果在 RUNNING 期间翻转时，
  会先取消旧分支再进入新分支，保证同一时刻不存在两个冲突状态。
- `Cooldown`：装饰单个子节点；子节点成功后进入冷却，冷却期内直接失败、不再驱动子节点。
  剩余冷却以虚拟时钟的绝对时间 `readyAt` 记录。
- `Action`：异步动作。`start` 可同步返回终态，或返回 `running` 后通过
  `ctx.wait` / `ctx.on` / `ctx.finish` 在后续 tick 完成。

## 确定性 tick 模型

每个 `tree.tick()` 严格按以下顺序执行：

1. 合并调用方传入的事件到队列；
2. 推进虚拟时钟，触发到期的 `wait` 回调（同一时刻按注册顺序）；
3. 按深度优先顺序把队列事件派发给订阅了该事件类型的活动 Action；
4. 从根节点重新评估整棵树。

Action 在第 2、3 阶段完成时会立即清理调用，并把终态记为 `pendingStatus`，
第 4 阶段由父节点吸收，**不会在同一 tick 重新 `start`**。因此“目标切换”和
“动作完成”事件同时到达时，旧动作不会复活，也不会出现两个重叠的追击状态。

## 黑板作用域

黑板是分层结构：

- `root` 全局层：通过 `ctx.setGlobal` / `ctx.getGlobal` 或 `blackboard.write/read` 访问。
- 每个 RUNNING 的 Action 调用拥有一个以 `invocationId` 命名的局部层：
  - `ctx.get(key)` / `ctx.set(key, value)` 走局部层，读取时沿层叠向上查找；
  - 局部层遮蔽 root 上的同名键；
  - 每次写入都记入该层 journal。

生命周期：

- Action **成功结束**：局部层 `commit`，合并进 root，局部层消失。
- Action **被取消或启动失败**：按 journal 逆序 `rollback`，覆盖和删除都会还原，
  root 与其他调用不受影响，局部层直接丢弃。

## 取消语义

取消通过父节点切换（如 `Branch` 换分支、`Parallel` 收敛、`Sequence/Selector` 中止）
或显式 `node.abort()` 触发，并沿树级联到活动 Action。对每个被取消的调用，运行时保证
`onCancel(ctx)` 返回后满足以下全部条件：

- 不存在该调用的活动 invocation，也没有残留子节点；
- 该调用注册的全部延迟回调（`ctx.wait`）已从虚拟时钟注销，不会再触发；
- 该调用在局部黑板上的全部写入（含 `onCancel` 内的写入）已回滚；
- 取消期间调用 `ctx.wait` 会抛错，不允许留下新的延迟回调；
- 发给已取消 `invocationId` 的定向事件会被直接丢弃。

取消后的 Action 可以在后续 tick 重新进入；`tree.actionStarts` 记录每个 Action 的
启动次数，测试据此断言不会多触发动作。

## 快照与恢复

`tree.snapshot()` 返回可 JSON 序列化的纯数据，包含：

- `schemaVersion` / `treeVersion` / `tick` / `invocationSeq`；
- `clock`：当前虚拟时间；`timers`：未触发的等待（含 `runAt`、`tag`、`payload`、所属 invocation）；
- `nodeStates`：每个节点的活动状态（Sequence/Selector 下标、Parallel 子状态、
  Branch 活动分支、Cooldown 的 `readyAt`、Action 的 `invocationId`）；
- `invocations`：活动调用、等待的事件类型与定时器；
- `blackboard`：root 值和每个活动调用的局部层有效值；
- `eventQueue`：尚未派发的事件。

`tree.restore(snapshot)` 用稳定节点 `id` 匹配状态并重建 invocation、事件处理器和定时器。

兼容规则：

- **节点必须声明稳定 `id`**。恢复按 id 绑定，id 缺失会报错而不是静默错位；
  只要 id 不变，节点的声明顺序可以调整（见重排测试）。
- **`treeVersion` 必须一致**，否则抛错；树结构变更需要显式升级版本。
- **旧 `schemaVersion` 自动迁移**：`src/snapshot.js` 只做纯数据升级
  （例如 v1 的 cooldown `remainingMs` 转为 v2 的绝对时间 `readyAt`）。
- 快照引用了运行时不存在的节点 id，或 Action 不再声明快照所需的事件类型时，恢复直接失败。
- 比运行时更新的快照版本拒绝恢复，避免高版本数据被低版本代码误读。
- 恢复后运行同一事件序列得到与原实例一致的快照（确定性回放测试覆盖）。

## 测试

```bash
node --test
```

覆盖场景：目标切换与动作完成同 tick、Parallel 一分支成功一分支失败、取消后重新进入、
快照跨版本恢复、节点声明顺序变化、相同事件序列确定性回放，以及源码禁用系统时间 API。
