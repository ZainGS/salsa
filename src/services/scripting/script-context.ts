/**
 * src/services/scripting/script-context.ts
 *
 * Builds a {@link ScriptContext} for one node from a {@link ScriptSceneAdapter} (docs/specs/script-behaviors.md §2.3).
 * The adapter supplies engine primitives (getPos/setPos/getYaw/…); this factory layers the derived math
 * (move / moveLocal / lookAt / distanceTo) so that logic stays pure + unit-testable against a mock adapter — the real
 * ShapeManager-backed adapter is wired in S2.
 *
 * ★ Yaw convention (must match the S2 adapter + engine forward): yaw about +Y, LOCAL FORWARD = +Z, so
 *   world forward = (sin yaw, 0, cos yaw). moveLocal + lookAt use this.
 */

import type { ScriptContext, ScriptSceneAdapter, NodeHandle, Vec3, ScriptInput } from './script-types';

const ORIGIN: Vec3 = [0, 0, 0];

/**
 * @param nodeId  the node this ctx drives (ctx.id)
 * @param adapter engine seam
 * @param getDt   returns the current tick's dt (seconds); the runner updates it each tick
 */
export function createScriptContext(
  nodeId: string,
  adapter: ScriptSceneAdapter,
  getDt: () => number,
): ScriptContext {
  const self = (): Vec3 => adapter.getPos(nodeId) ?? ORIGIN;

  const ctx: ScriptContext = {
    get id() { return nodeId; },
    get playerId() { return adapter.playerId(); },

    pos(): Vec3 {
      const p = adapter.getPos(nodeId);
      return p ? [p[0], p[1], p[2]] : [0, 0, 0];
    },
    setPos(x, y, z) { adapter.setPos(nodeId, x, y, z); },
    move(dx, dy, dz) {
      const p = self();
      adapter.setPos(nodeId, p[0] + dx, p[1] + dy, p[2] + dz);
    },
    moveLocal(dx, dy, dz) {
      const yaw = adapter.getYaw(nodeId);
      const s = Math.sin(yaw), c = Math.cos(yaw);
      // local (+X right, +Z forward) → world, rotating about +Y
      const wx = dx * c + dz * s;
      const wz = -dx * s + dz * c;
      const p = self();
      adapter.setPos(nodeId, p[0] + wx, p[1] + dy, p[2] + wz);
    },
    rotateY(rad) { adapter.setYaw(nodeId, adapter.getYaw(nodeId) + rad); },
    setYaw(rad) { adapter.setYaw(nodeId, rad); },
    lookAt(x, y, z) {
      const p = self();
      const dx = x - p[0], dz = z - p[2];
      if (dx === 0 && dz === 0) return;      // degenerate: keep current yaw
      adapter.setYaw(nodeId, Math.atan2(dx, dz));
    },

    play(clip, opts) { adapter.play(nodeId, clip, opts); },
    stop() { adapter.stop(nodeId); },

    find(id): NodeHandle | null {
      if (!adapter.exists(id)) return null;
      return {
        get id() { return id; },
        pos: () => adapter.getPos(id),
        setPos: (x, y, z) => adapter.setPos(id, x, y, z),
      };
    },
    posOf(id) { return adapter.getPos(id); },
    distanceTo(id) {
      const a = adapter.getPos(nodeId), b = adapter.getPos(id);
      if (!a || !b) return null;
      const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
    raycast(origin, dir, maxDist) { return adapter.raycast(origin, dir, maxDist); },

    spawn(templateId, pos) { return adapter.spawn(templateId, pos); },
    destroy(id) { adapter.destroy(id); },

    getVar(name) { return adapter.getVar(name); },
    setVar(name, v) { adapter.setVar(name, v); },

    get input(): ScriptInput { return adapter.input(); },

    emit(event) { adapter.emit(event); },

    get time() { return adapter.now(); },
    get dt() { return getDt(); },
  };

  return ctx;
}
