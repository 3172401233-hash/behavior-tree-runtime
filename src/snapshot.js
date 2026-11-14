export const SNAPSHOT_VERSION = 2;

/**
 * 历史快照升级。
 *
 * v1 -> v2 的变化：
 *   - cooldown 节点状态从扁平的 { remainingMs } 改为 { readyAt }（绝对虚拟时间）；
 *   - 节点状态统一收敛到 nodeStates（v1 里 cooldown 单独存放）；
 *   - invocation 的等待条件从 waits 改名为 events/timers 并补齐结构。
 *
 * 升级只做纯数据变换，不依赖任何节点实例，因此可以跨代码版本运行。
 */
export function migrateSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new Error('invalid snapshot: expected an object');
  }
  const version = snapshot.schemaVersion ?? 1;
  if (version > SNAPSHOT_VERSION) {
    throw new Error(
      `snapshot schema ${version} is newer than runtime ${SNAPSHOT_VERSION}`,
    );
  }

  let data = structuredClone(snapshot);
  if (version === 1) data = migrateV1ToV2(data);
  return data;
}

function migrateV1ToV2(v1) {
  const now = v1.clock ?? 0;
  const nodeStates = { ...(v1.nodeStates ?? {}) };
  for (const [id, cooldown] of Object.entries(v1.cooldowns ?? {})) {
    const remaining = cooldown.remainingMs ?? 0;
    nodeStates[id] = { readyAt: remaining > 0 ? now + remaining : null };
  }
  const invocations = (v1.invocations ?? []).map((invocation) => ({
    id: invocation.id,
    nodeId: invocation.nodeId,
    events: invocation.waits?.events ?? [],
    timers: (invocation.waits?.timers ?? []).map((timer) => ({
      runAt: timer.runAt,
      tag: timer.tag ?? null,
      payload: timer.payload ?? null,
    })),
  }));
  return {
    ...v1,
    schemaVersion: 2,
    nodeStates,
    invocations,
    timers: v1.timers ?? [],
  };
}
