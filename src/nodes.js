export const Status = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  RUNNING: 'running',
});

let autoIdCounter = 0;
const isActionNode = (node) => node !== null && typeof node === 'object' && typeof node.start === 'function';

export class Node {
  constructor({ id, name } = {}) {
    this.id = id ?? `node_${++autoIdCounter}`;
    this.name = name ?? this.constructor.name;
    this.tree = null;
  }

  /** @param {import('./runtime.js').BehaviorTree} tree */
  bind(tree) {
    this.tree = tree;
    return this;
  }

  tick() {
    throw new Error(`${this.constructor.name}.tick() not implemented`);
  }

  abort() {}

  snapshotState() {
    return null;
  }

  restoreState() {}
}

/**
 * 顺序节点：依次执行子节点，全成功才成功；任一失败立即失败。
 * 记忆化：RUNNING 后下一次 tick 从记录的子节点继续，不重复触发已完成子节点。
 */
export class Sequence extends Node {
  constructor(options = {}) {
    super(options);
    this.children = options.children ?? [];
    this.index = 0;
  }

  bind(tree) {
    super.bind(tree);
    this.children.forEach((child) => child.bind(tree));
    return this;
  }

  tick(ctx) {
    while (this.index < this.children.length) {
      const status = this.children[this.index].tick(ctx);
      if (status === Status.RUNNING) return Status.RUNNING;
      if (status === Status.FAILURE) {
        this.index = 0;
        return Status.FAILURE;
      }
      this.index += 1;
    }
    this.index = 0;
    return Status.SUCCESS;
  }

  abort() {
    if (this.index < this.children.length) this.children[this.index].abort();
    this.index = 0;
  }

  snapshotState() {
    return { index: this.index };
  }

  restoreState(state) {
    this.index = state?.index ?? 0;
  }
}

/**
 * 选择节点：依次尝试子节点，任一成功立即成功；全失败才失败。
 */
export class Selector extends Node {
  constructor(options = {}) {
    super(options);
    this.children = options.children ?? [];
    this.index = 0;
  }

  bind(tree) {
    super.bind(tree);
    this.children.forEach((child) => child.bind(tree));
    return this;
  }

  tick(ctx) {
    while (this.index < this.children.length) {
      const status = this.children[this.index].tick(ctx);
      if (status === Status.RUNNING) return Status.RUNNING;
      if (status === Status.SUCCESS) {
        this.index = 0;
        return Status.SUCCESS;
      }
      this.index += 1;
    }
    this.index = 0;
    return Status.FAILURE;
  }

  abort() {
    if (this.index < this.children.length) this.children[this.index].abort();
    this.index = 0;
  }

  snapshotState() {
    return { index: this.index };
  }

  restoreState(state) {
    this.index = state?.index ?? 0;
  }
}

/**
 * 并行节点：每个 tick 驱动全部未结束子节点。
 * successPolicy: 'all'（默认，全部成功）| 'any'（任一成功）
 * failurePolicy: 'any'（默认，任一失败即整体失败）| 'all'
 * 策略达成后，仍在运行的子节点会被级联取消。
 */
export class Parallel extends Node {
  constructor(options = {}) {
    super(options);
    this.children = options.children ?? [];
    this.successPolicy = options.successPolicy ?? 'all';
    this.failurePolicy = options.failurePolicy ?? 'any';
    this.statuses = new Array(this.children.length).fill(null);
  }

  bind(tree) {
    super.bind(tree);
    this.children.forEach((child) => child.bind(tree));
    return this;
  }

  tick(ctx) {
    let successes = 0;
    let failures = 0;
    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i];
      if (isActionNode(child) && child.pendingStatus !== null) {
        // 动作在本 tick 的事件/时钟阶段已完成：直接吸收终态，不重新驱动。
        this.statuses[i] = child.pendingStatus;
        child.pendingStatus = null;
      } else if (this.statuses[i] === null) {
        this.statuses[i] = child.tick(ctx);
      }
      if (this.statuses[i] === Status.SUCCESS) successes += 1;
      if (this.statuses[i] === Status.FAILURE) failures += 1;
    }

    const succeeded =
      this.successPolicy === 'any' ? successes > 0 : successes === this.children.length;
    const failed =
      this.failurePolicy === 'any' ? failures > 0 : failures === this.children.length;

    if (succeeded || failed) {
      this.abortRunningChildren();
      const result = failed && !succeeded ? Status.FAILURE : Status.SUCCESS;
      this.statuses.fill(null);
      return result;
    }
    return Status.RUNNING;
  }

  abortRunningChildren() {
    for (let i = 0; i < this.children.length; i++) {
      if (this.statuses[i] === null || this.statuses[i] === Status.RUNNING) {
        this.children[i].abort();
      }
    }
  }

  abort() {
    this.abortRunningChildren();
    this.statuses.fill(null);
  }

  snapshotState() {
    return { statuses: this.statuses.slice() };
  }

  restoreState(state) {
    const statuses = state?.statuses ?? [];
    this.statuses = this.children.map((_, i) => statuses[i] ?? null);
  }
}

/** 条件节点：同步谓词，成功/失败，不会 RUNNING。 */
export class Condition extends Node {
  constructor(options = {}) {
    super(options);
    this.predicate = options.predicate;
  }

  tick(ctx) {
    return this.predicate(ctx) ? Status.SUCCESS : Status.FAILURE;
  }
}

/** 条件分支：谓词为真走 then，否则走 else（else 缺省视为失败）。 */
export class Branch extends Node {
  constructor(options = {}) {
    super(options);
    this.predicate = options.predicate;
    this.thenNode = options.then ?? null;
    this.elseNode = options.else ?? null;
    this.activeBranch = null;
  }

  bind(tree) {
    super.bind(tree);
    this.thenNode?.bind(tree);
    this.elseNode?.bind(tree);
    return this;
  }

  tick(ctx) {
    const chosen = this.predicate(ctx) ? 'then' : 'else';
    if (this.activeBranch !== null && this.activeBranch !== chosen) {
      // 目标/条件切换：先取消上一分支的活动动作，再进入新分支，
      // 保证同一时刻不会有两个互相冲突的状态在跑。
      this.abort();
    }
    this.activeBranch = chosen;
    const child = this.activeBranch === 'then' ? this.thenNode : this.elseNode;
    if (!child) {
      this.activeBranch = null;
      return Status.FAILURE;
    }
    const status = child.tick(ctx);
    if (status !== Status.RUNNING) this.activeBranch = null;
    return status;
  }

  abort() {
    if (this.activeBranch) {
      const child = this.activeBranch === 'then' ? this.thenNode : this.elseNode;
      child?.abort();
      this.activeBranch = null;
    }
  }

  snapshotState() {
    return { activeBranch: this.activeBranch };
  }

  restoreState(state) {
    this.activeBranch = state?.activeBranch ?? null;
  }
}

/**
 * 冷却装饰器：子节点成功后进入冷却，冷却期内直接返回失败（不再驱动子节点）。
 * 冷却时间只由虚拟时钟推进。
 */
export class Cooldown extends Node {
  constructor(options = {}) {
    super(options);
    this.child = options.child;
    this.durationMs = options.durationMs;
    this.readyAt = null;
  }

  bind(tree) {
    super.bind(tree);
    this.child.bind(tree);
    return this;
  }

 tick(ctx) {
    if (this.readyAt !== null && ctx.clock.now() < this.readyAt) {
      return Status.FAILURE;
    }
    const status = this.child.tick(ctx);
    if (status === Status.SUCCESS) this.readyAt = ctx.clock.now() + this.durationMs;
    return status;
  }

  abort() {
    this.child.abort();
  }

  remainingMs(now) {
    return this.readyAt === null ? 0 : Math.max(0, this.readyAt - now);
  }

  snapshotState() {
    return { readyAt: this.readyAt };
  }

  restoreState(state) {
    this.readyAt = state?.readyAt ?? null;
  }
}

/**
 * 异步动作。
 *
 * start(ctx) 可以同步返回 success/failure，也可以返回 running（或缺省），
 * 之后通过 ctx.wait / ctx.on / ctx.finish 在后续 tick 产生结果。
 * onCancel(ctx) 是必选的清理钩子；运行时保证它返回后：
 *   - 不存在该调用的子节点/活动 invocation；
 *   - 该调用的黑板写入全部回滚；
 *   - 该调用注册的延迟回调全部注销。
 */
export class Action extends Node {
  constructor(options = {}) {
    super(options);
    this.start = options.start;
    this.onCancel = options.onCancel ?? (() => {});
    // 声明式事件订阅：恢复快照后运行时据此重新绑定处理器，
    // 保证“等待条件”可以跨快照存活。
    this.events = options.events ?? {};
    this.activeInvocationId = null;
    this.pendingStatus = null;
  }

  get running() {
    return this.activeInvocationId !== null;
  }

  tick(ctx) {
    if (this.activeInvocationId === null) {
      if (this.pendingStatus !== null) {
        // 调用在事件/时钟阶段已结束：本 tick 返回其终态，不重新启动。
        const status = this.pendingStatus;
        this.pendingStatus = null;
        return status;
      }
      this.pendingStatus = null;
      const invocationId = ctx.runtime._beginInvocation(this);
      const invocationCtx = ctx.runtime._contextFor(invocationId, ctx);
      let status;
      try {
        status = this.start(invocationCtx);
      } catch (error) {
        ctx.runtime._failInvocation(invocationId, error);
        throw error;
      }
      if (status === Status.SUCCESS || status === Status.FAILURE) {
        ctx.runtime._endInvocation(invocationId, status);
        return status;
      }
      this.activeInvocationId = invocationId;
      return Status.RUNNING;
    }
    return Status.RUNNING;
  }

  abort() {
    if (this.activeInvocationId === null) return;
    const invocationId = this.activeInvocationId;
    this.activeInvocationId = null;
    this.pendingStatus = null;
    this.tree._cancelInvocation(invocationId, this);
  }

  snapshotState() {
    return this.activeInvocationId === null
      ? null
      : { invocationId: this.activeInvocationId };
  }

  restoreState(state) {
    this.activeInvocationId = state?.invocationId ?? null;
    this.pendingStatus = null;
  }
}
