/**
 * 虚拟时钟：唯一的时间来源。运行时禁止直接访问 Date.now / performance.now
 * 或 setTimeout 等系统定时器，所有“时间”和“延迟回调”都由调用方 tick 推进。
 */
export class VirtualClock {
  #now = 0;
  #timers = [];
  #seq = 0;

  now() {
    return this.#now;
  }

  /**
   * 推进时钟并触发所有到期定时器。
   * 同一时刻的定时器按注册顺序触发，保证确定性。
   */
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`clock.advance requires a non-negative finite number, got ${ms}`);
    }
    const target = this.#now + ms;
    while (true) {
      const due = this.#timers
        .filter((timer) => timer.runAt <= target)
        .sort((a, b) => a.runAt - b.runAt || a.id - b.id);
      if (due.length === 0) break;
      const timer = due[0];
      this.#now = timer.runAt;
      this.#timers = this.#timers.filter((item) => item.id !== timer.id);
      if (!timer.cancelled) timer.callback();
    }
    this.#now = target;
  }

  set(runAt) {
    if (runAt < this.#now) {
      throw new RangeError('virtual clock cannot move backwards');
    }
    this.#now = runAt;
  }

  /**
   * 注册一次性定时器。返回不透明句柄，cancel 时按句柄移除。
   */
  schedule(delayMs, callback, meta = {}) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError(`schedule requires a non-negative finite delay, got ${delayMs}`);
    }
    const timer = {
      id: ++this.#seq,
      runAt: this.#now + delayMs,
      callback,
      cancelled: false,
      tag: meta.tag ?? null,
      payload: meta.payload ?? null,
      invocationId: meta.invocationId ?? null,
    };
    this.#timers.push(timer);
    return timer;
  }

  cancel(handle) {
    if (!handle) return;
    this.#timers = this.#timers.filter((timer) => timer.id !== handle.id);
  }

  pending() {
    return this.#timers.slice();
  }

  /** 快照恢复：丢弃旧回调，按数据重建（回调由运行时重新绑定）。 */
  _reset(now, rawTimers, rebind) {
    this.#now = now;
    this.#seq = 0;
    this.#timers = rawTimers.map((entry) => ({
      id: ++this.#seq,
      runAt: entry.runAt,
      callback: rebind(entry),
      cancelled: false,
      tag: entry.tag ?? null,
      payload: entry.payload ?? null,
      invocationId: entry.invocationId ?? null,
    }));
  }
}

/** 任何运行时代码只允许从这里取时间。 */
export const FORBIDDEN_TIME_APIS = [
  'setTimeout',
  'setInterval',
  'setImmediate',
  'Date.now',
  'performance.now',
];
