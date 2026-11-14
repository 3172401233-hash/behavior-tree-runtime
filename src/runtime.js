import { VirtualClock } from './clock.js';
import { Blackboard } from './blackboard.js';
import { Action, Status } from './nodes.js';
import { migrateSnapshot, SNAPSHOT_VERSION } from './snapshot.js';

const isActionNode = (node) => node instanceof Action;

/**
 * 行为树运行时。
 *
 * 确定性约定：
 *   - 时间只能来自外部注入的 VirtualClock，内部不允许任何系统 timer；
 *   - 每个 tick 依次处理：到期 wait 回调 -> 队列事件 -> 从根节点重新评估；
 *   - 同一 tick 内完成的 Action 立刻清理，后续事件不会再送达它，
 *     因此“目标切换”与“动作完成”同时到达时不会产生两个冲突状态。
 */
export class BehaviorTree {
  constructor(root, options = {}) {
    this.clock = options.clock ?? new VirtualClock();
    this.blackboard = options.blackboard ?? new Blackboard();
    this.root = root;
    this.root.bind(this);

    this.nodes = new Map();
    this.invocations = new Map();
    this.eventQueue = [];
    this.invocationSeq = 0;
    this.treeVersion = options.treeVersion ?? 1;
    this.tickCount = 0;
    this.actionStarts = new Map();
    this.#register(root);
  }

  #register(node) {
    if (this.nodes.has(node.id)) {
      throw new Error(`duplicate node id: ${node.id}`);
    }
    this.nodes.set(node.id, node);
    const children = node.children ?? (node.child ? [node.child] : []);
    for (const child of children) this.#register(child);
    if (node.thenNode) this.#register(node.thenNode);
    if (node.elseNode) this.#register(node.elseNode);
  }

  // ---- Action 调用生命周期 -------------------------------------------------

  _beginInvocation(actionNode) {
    const invocationId = `inv_${++this.invocationSeq}`;
    this.blackboard.pushScope(invocationId, invocationId);
    const invocation = {
      id: invocationId,
      nodeId: actionNode.id,
      events: Object.entries(actionNode.events ?? {}).map(([type, handler]) => ({
        type,
        handler,
      })),
      timers: [],
      aborted: false,
      finished: false,
    };
    this.invocations.set(invocationId, invocation);
    this.actionStarts.set(
      actionNode.id,
      (this.actionStarts.get(actionNode.id) ?? 0) + 1,
    );
    return invocationId;
  }

  _contextFor(invocationId, parentCtx = {}) {
    const invocation = this.invocations.get(invocationId);
    const board = this.blackboard;
    const tree = this;
    return {
      invocationId,
      clock: this.clock,
      event: parentCtx.event ?? null,
      get blackboard() {
        return board;
      },
      get(key) {
        return board.read(key, invocationId);
      },
      set(key, value) {
        board.write(key, value, invocationId);
      },
      remove(key) {
        board.delete(key, invocationId);
      },
      getGlobal(key) {
        return board.read(key);
      },
      setGlobal(key, value) {
        board.write(key, value);
      },
      /** 注册延迟回调；回调在后续 tick 的时钟阶段触发，可被取消。 */
      wait(delayMs, payload = null, tag = null) {
        if (invocation.aborted) {
          throw new Error(`cannot wait on aborted invocation ${invocationId}`);
        }
        return tree._registerTimer(invocationId, delayMs, payload, tag);
      },
      /** 订阅外部事件类型；事件按深度优先顺序送达所有匹配的活动调用。 */
      on(eventType, handler) {
        invocation.events.push({ type: eventType, handler });
      },
      /** 多帧动作显式完成。同 tick 内立刻生效并清理。 */
      finish(status = Status.SUCCESS, result = null) {
        if (invocation.finished || invocation.aborted) return;
        tree._completeInvocation(invocationId, status, result);
      },
      fail(result = null) {
        this.finish(Status.FAILURE, result);
      },
      get aborted() {
        return invocation.aborted;
      },
    };
  }

  _registerTimer(invocationId, delayMs, payload, tag) {
    const invocation = this.invocations.get(invocationId);
    const handle = this.clock.schedule(
      delayMs,
      () => {
        if (!this.invocations.has(invocationId)) return;
        const live = this.invocations.get(invocationId);
        if (live.aborted || live.finished) return;
        this.#fireEvent(invocationId, { type: '__timer__', payload, tag });
      },
      { tag, payload, invocationId },
    );
    invocation.timers.push(handle);
    return handle;
  }

  #cancelTimers(invocation) {
    for (const handle of invocation.timers) this.clock.cancel(handle);
    invocation.timers = [];
  }

  _completeInvocation(invocationId, status) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.finished || invocation.aborted) return;
    invocation.finished = true;
    this.#cancelTimers(invocation);
    this.blackboard.commitScope(invocationId);
    const node = this.nodes.get(invocation.nodeId);
    this.invocations.delete(invocationId);
    if (isActionNode(node) && node.activeInvocationId === invocationId) {
      node.activeInvocationId = null;
      // 事件/时钟阶段完成：记住终态，等本轮树评估返回，避免重复 start。
      node.pendingStatus = status;
    }
  }

  _endInvocation(invocationId, status) {
    this._completeInvocation(invocationId, status);
  }

  _failInvocation(invocationId) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.finished || invocation.aborted) return;
    invocation.finished = true;
    this.#cancelTimers(invocation);
    this.blackboard.rollbackScope(invocationId);
    this.invocations.delete(invocationId);
    const node = this.nodes.get(invocation.nodeId);
    if (isActionNode(node) && node.activeInvocationId === invocationId) {
      node.activeInvocationId = null;
    }
  }

  _cancelInvocation(invocationId, actionNode) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.aborted) return;
    invocation.aborted = true;
    const ctx = this._contextFor(invocationId, { event: null });
    try {
      actionNode.onCancel(ctx);
    } finally {
      // 无论清理钩子做了什么，运行时强制注销回调并回滚黑板。
      this.#cancelTimers(invocation);
      this.blackboard.rollbackScope(invocationId);
      this.invocations.delete(invocationId);
      if (actionNode.activeInvocationId === invocationId) {
        actionNode.activeInvocationId = null;
      }
    }
  }

  // ---- 事件系统 -----------------------------------------------------------

  queueEvent(event) {
    this.eventQueue.push({ ...event });
  }

  #runningActions(node, acc) {
    if (isActionNode(node) && node.running) acc.push(node);
    const children = node.children ?? (node.child ? [node.child] : []);
    for (const child of children) this.#runningActions(child, acc);
    if (node.thenNode) this.#runningActions(node.thenNode, acc);
    if (node.elseNode) this.#runningActions(node.elseNode, acc);
    return acc;
  }

  #fireEvent(invocationId, event) {
    const invocation = this.invocations.get(invocationId);
    if (!invocation || invocation.aborted || invocation.finished) return;
    const handlerEntry = invocation.events.find((entry) => entry.type === event.type);
    const handler = handlerEntry?.handler;
    const ctx = this._contextFor(invocationId, { event });
    if (handler) handler(ctx, event);
  }

  #drainEvents() {
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue[0];
      if (event.invocationId) {
        if (this.invocations.has(event.invocationId)) {
          this.#fireEvent(event.invocationId, event);
        }
        this.eventQueue.shift();
        continue;
      }
      const actions = this.#runningActions(this.root, []);
      for (const action of actions) {
        const invocation = this.invocations.get(action.activeInvocationId);
        if (!invocation || invocation.aborted || invocation.finished) continue;
        const subscribed = invocation.events.some((entry) => entry.type === event.type);
        if (subscribed) this.#fireEvent(invocation.id, event);
      }
      this.eventQueue.shift();
    }
  }

  // ---- 主循环 -------------------------------------------------------------

  /**
   * 推进一个 tick。
   * @param {{events?: object[], advanceMs?: number}} [input]
   * @returns 根节点状态
   */
  tick(input = {}) {
    if (input.events) {
      for (const event of input.events) this.queueEvent(event);
    }
    if (input.advanceMs) this.clock.advance(input.advanceMs);
    this.#drainEvents();
    this.tickCount += 1;
    const status = this.root.tick({
      clock: this.clock,
      blackboard: this.blackboard,
      runtime: this,
      event: null,
    });
    return status;
  }

  activeNodeIds() {
    return this.#runningActions(this.root, []).map((node) => node.id);
  }

  // ---- 快照与恢复 ---------------------------------------------------------

  snapshot() {
    const nodeStates = {};
    for (const [id, node] of this.nodes) {
      const state = node.snapshotState();
      if (state !== null && state !== undefined) nodeStates[id] = state;
    }
    const invocations = [];
    for (const invocation of this.invocations.values()) {
      invocations.push({
        id: invocation.id,
        nodeId: invocation.nodeId,
        events: invocation.events.map((entry) => entry.type),
        timers: invocation.timers.map((handle) => ({
          runAt: handle.runAt,
          tag: handle.tag,
          payload: handle.payload,
        })),
      });
    }
    return {
      schemaVersion: SNAPSHOT_VERSION,
      treeVersion: this.treeVersion,
      tick: this.tickCount,
      invocationSeq: this.invocationSeq,
      clock: this.clock.now(),
      timers: this.clock.pending().map((handle) => ({
        runAt: handle.runAt,
        invocationId: handle.invocationId,
        tag: handle.tag,
        payload: handle.payload,
      })),
      blackboard: this.blackboard.snapshot(),
      nodeStates,
      invocations,
      eventQueue: this.eventQueue.map((event) => structuredClone(event)),
    };
  }

  /**
   * 从快照恢复。接受历史版本快照（经 migrateSnapshot 升级）。
   * 节点通过稳定 id 匹配；id 缺失或类型变化会抛出异常而不是静默错位。
   */
  restore(rawSnapshot) {
    const data = migrateSnapshot(rawSnapshot);
    if (data.treeVersion !== this.treeVersion) {
      throw new Error(
        `tree version mismatch: snapshot=${data.treeVersion} runtime=${this.treeVersion}`,
      );
    }

    this.tickCount = data.tick ?? 0;
    this.invocationSeq = data.invocationSeq ?? 0;
    this.eventQueue = (data.eventQueue ?? []).map((event) => structuredClone(event));
    this.blackboard = Blackboard.restore(data.blackboard);

    for (const [id, state] of Object.entries(data.nodeStates ?? {})) {
      const node = this.nodes.get(id);
      if (!node) throw new Error(`snapshot references unknown node id: ${id}`);
      node.restoreState(state);
    }

    this.invocations = new Map();
    for (const entry of data.invocations ?? []) {
      const node = this.nodes.get(entry.nodeId);
      if (!isActionNode(node)) {
        throw new Error(`snapshot invocation ${entry.id} references non-action node ${entry.nodeId}`);
      }
      if (node.activeInvocationId !== entry.id) {
        throw new Error(`snapshot invocation ${entry.id} not bound to action ${entry.nodeId}`);
      }
      const events = (entry.events ?? []).map((type) => {
        const handler = node.events[type];
        if (!handler) {
          throw new Error(
            `action ${node.id} no longer declares event "${type}" required by snapshot`,
          );
        }
        return { type, handler };
      });
      this.invocations.set(entry.id, {
        id: entry.id,
        nodeId: entry.nodeId,
        events,
        timers: [],
        aborted: false,
        finished: false,
      });
      if (!this.blackboard._scopeExists(entry.id)) {
        this.blackboard.pushScope(entry.id, entry.id);
      }
    }

    this.clock._reset(data.clock ?? 0, data.timers ?? [], (entry) => () => {
      if (!entry.invocationId || !this.invocations.has(entry.invocationId)) return;
      const live = this.invocations.get(entry.invocationId);
      if (live.aborted || live.finished) return;
      this.#fireEvent(entry.invocationId, {
        type: '__timer__',
        payload: entry.payload ?? null,
        tag: entry.tag ?? null,
      });
    });

    for (const handle of this.clock.pending()) {
      if (handle.invocationId && this.invocations.has(handle.invocationId)) {
        this.invocations.get(handle.invocationId).timers.push(handle);
      }
    }
    return this;
  }
}
