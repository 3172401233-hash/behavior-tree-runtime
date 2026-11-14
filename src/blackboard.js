const clone = (value) => (value === undefined ? value : structuredClone(value));

/**
 * 分层黑板。
 *
 * 层级：
 *   root（全局）-> action invocation 局部层（每个 RUNNING 的 Action 一个）
 *
 * 读取沿层叠结构向上查找；默认写入落到调用方当前层，并记入该层 journal。
 * Action 成功结束时局部层 commit（合并进 root）；被取消时 rollback，
 * 连同其注册的延迟回调一起被运行时清除，黑板上不会留下痕迹。
 */
export class Blackboard {
  #layers = [];

  constructor() {
    this.#layers.push({ name: 'root', values: new Map(), journal: null });
  }

  pushScope(name, invocationId) {
    if (this.#layers.some((layer) => layer.name === name)) {
      throw new Error(`blackboard scope already active: ${name}`);
    }
    this.#layers.push({ name, values: new Map(), journal: [], invocationId });
  }

  #findScope(name) {
    return this.#layers.find((layer) => layer.name === name);
  }

  #currentScope(invocationId) {
    if (invocationId !== undefined) {
      const scoped = this.#layers.find((layer) => layer.invocationId === invocationId);
      if (scoped) return scoped;
    }
    return this.#layers[this.#layers.length - 1];
  }

  read(key, invocationId) {
    for (let i = this.#layers.length - 1; i >= 0; i--) {
      if (this.#layers[i].values.has(key)) {
        return this.#layers[i].values.get(key);
      }
    }
    return undefined;
  }

  has(key, invocationId) {
    for (let i = this.#layers.length - 1; i >= 0; i--) {
      if (this.#layers[i].values.has(key)) return true;
    }
    return false;
  }

  /** 局部写入：记入 journal，取消时按记录还原。 */
  write(key, value, invocationId) {
    const scope = this.#currentScope(invocationId);
    if (scope.journal) {
      const existed = scope.values.has(key);
      scope.journal.push({
        key,
        had: existed,
        previous: existed ? scope.values.get(key) : undefined,
      });
    }
    scope.values.set(key, value);
  }

  delete(key, invocationId) {
    const scope = this.#currentScope(invocationId);
    if (scope.journal) {
      const existed = scope.values.has(key);
      scope.journal.push({
        key,
        had: existed,
        previous: existed ? scope.values.get(key) : undefined,
        delete: true,
      });
    }
    scope.values.delete(key);
  }

  /** Action 正常结束：局部层合并到 root 后弹出。 */
  commitScope(name) {
    const index = this.#layers.findIndex((layer) => layer.name === name);
    if (index < 0) throw new Error(`unknown blackboard scope: ${name}`);
    const scope = this.#layers[index];
    const root = this.#layers[0];
    for (const [key, value] of scope.values) root.values.set(key, value);
    this.#layers.splice(index, 1);
  }

  /** Action 被取消：按 journal 逆序还原本层写入，然后丢弃整层。 */
  rollbackScope(name) {
    const index = this.#layers.findIndex((layer) => layer.name === name);
    if (index < 0) return;
    const scope = this.#layers[index];
    for (let i = scope.journal.length - 1; i >= 0; i--) {
      const entry = scope.journal[i];
      if (entry.delete || !entry.had) {
        scope.values.delete(entry.key);
      } else {
        scope.values.set(entry.key, entry.previous);
      }
    }
    this.#layers.splice(index, 1);
  }

  activeScopeNames() {
    return this.#layers.slice(1).map((layer) => layer.name);
  }

  snapshot() {
    const root = {};
    for (const [key, value] of this.#layers[0].values) root[key] = clone(value);
    const scopes = this.#layers.slice(1).map((layer) => {
      const values = {};
      for (const [key, value] of layer.values) values[key] = clone(value);
      return { name: layer.name, invocationId: layer.invocationId, values };
    });
    return { root, scopes };
  }

  static restore(data) {
    const board = new Blackboard();
    board.#layers = [{ name: 'root', values: new Map(Object.entries(data.root ?? {})), journal: null }];
    for (const scope of data.scopes ?? []) {
      board.#layers.push({
        name: scope.name,
        invocationId: scope.invocationId,
        values: new Map(Object.entries(scope.values ?? {})),
        journal: [],
      });
    }
    return board;
  }

  _scopeExists(name) {
    return this.#findScope(name) !== undefined;
  }
}
