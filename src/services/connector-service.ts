/**
 * ConnectorService — manages snapping line endpoints to shape connection ports
 * and auto-updating bound connectors when shapes are moved/resized.
 *
 * Usage:
 *  - During line drawing, call `findSnapTarget(worldX, worldY)` to find the nearest port.
 *  - After drawing, bind a line endpoint via `bindStart(line, shapeId, portId)` or `bindEnd(...)`.
 *  - Call `updateBoundConnectors()` on each frame / after any shape transform to keep connectors in sync.
 */

import { SceneGraph } from '../scene-graph/core/scene-graph';
import { Node } from '../scene-graph/shapes/base/node';
import { Shape, ConnectionPoint } from '../scene-graph/shapes/base/shape';
import { Line } from '../scene-graph/shapes/line';

export interface SnapResult {
  /** The shape that owns the port. */
  shapeId: string;
  /** The port ID. */
  portId: string;
  /** World-space position of the port. */
  x: number;
  y: number;
  /** Distance from the query point to the port. */
  distance: number;
}

export class ConnectorService {
  private sceneGraph: SceneGraph;
  /** World-space snap threshold (how close the cursor must be to a port to snap). */
  public snapThreshold: number = 0.03;

  constructor(sceneGraph: SceneGraph) {
    this.sceneGraph = sceneGraph;
  }

  // ── Snap Logic ────────────────────────────────────────────────────

  /**
   * Find the nearest connection port to a world-space position.
   * Returns null if nothing is within the snap threshold.
   * Optionally excludes a shape (e.g. the line itself).
   */
  public findSnapTarget(worldX: number, worldY: number, excludeShapeId?: string): SnapResult | null {
    let best: SnapResult | null = null;

    this.sceneGraph.root.forEachDeep((node: Node) => {
      if (!(node instanceof Shape)) return;
      if (node instanceof Line) return; // Don't snap to other lines' connection points
      if (excludeShapeId && node.id === excludeShapeId) return;

      const pts = node.getConnectionPoints();
      for (const p of pts) {
        const d = Math.hypot(p.x - worldX, p.y - worldY);
        if (d <= this.snapThreshold && (!best || d < best.distance)) {
          best = {
            shapeId: node.id,
            portId: p.id,
            x: p.x,
            y: p.y,
            distance: d,
          };
        }
      }
    });

    return best;
  }

  /**
   * Get all connection points for all shapes (for rendering snap indicators).
   * Optionally filter to only shapes near a world-space point.
   */
  public getAllConnectionPoints(nearWorldX?: number, nearWorldY?: number, radius?: number): { shapeId: string; point: ConnectionPoint }[] {
    const results: { shapeId: string; point: ConnectionPoint }[] = [];
    const r = radius ?? Infinity;

    this.sceneGraph.root.forEachDeep((node: Node) => {
      if (!(node instanceof Shape)) return;
      if (node instanceof Line) return;

      const pts = node.getConnectionPoints();
      for (const p of pts) {
        if (nearWorldX !== undefined && nearWorldY !== undefined) {
          const d = Math.hypot(p.x - nearWorldX, p.y - nearWorldY);
          if (d > r) continue;
        }
        results.push({ shapeId: node.id, point: p });
      }
    });

    return results;
  }

  // ── Binding API ───────────────────────────────────────────────────

  /** Bind the start endpoint of a line to a shape's port. */
  public bindStart(line: Line, shapeId: string, portId: string): void {
    line.startBinding = { shapeId, portId };
    this.updateLineEndpoint(line, 'start');
  }

  /** Bind the end endpoint of a line to a shape's port. */
  public bindEnd(line: Line, shapeId: string, portId: string): void {
    line.endBinding = { shapeId, portId };
    this.updateLineEndpoint(line, 'end');
  }

  /** Unbind the start endpoint. */
  public unbindStart(line: Line): void {
    line.startBinding = null;
  }

  /** Unbind the end endpoint. */
  public unbindEnd(line: Line): void {
    line.endBinding = null;
  }

  // ── Auto-Update Bound Connectors ──────────────────────────────────

  /**
   * Walk all Line shapes and update any bound endpoints to match their
   * target shape's current port position. Call this after shapes are
   * moved/resized/rotated.
   */
  public updateBoundConnectors(): void {
    this.sceneGraph.root.forEachDeep((node: Node) => {
      if (!(node instanceof Line)) return;
      const line = node as Line;

      if (line.startBinding) {
        this.updateLineEndpoint(line, 'start');
      }
      if (line.endBinding) {
        this.updateLineEndpoint(line, 'end');
      }
    });
  }

  /**
   * Update a specific line's bound endpoint to the current port position.
   * Returns true if the line was actually moved.
   */
  private updateLineEndpoint(line: Line, which: 'start' | 'end'): boolean {
    const binding = which === 'start' ? line.startBinding : line.endBinding;
    if (!binding) return false;

    // Find the target shape
    const targetNode = this.sceneGraph.findNodeById(binding.shapeId);
    if (!targetNode || !(targetNode instanceof Shape)) return false;

    // Find the port
    const pts = (targetNode as Shape).getConnectionPoints();
    const port = pts.find(p => p.id === binding.portId);
    if (!port) return false;

    // Convert port world position to the Line's local coordinate space
    const inv = line.getInverseLocalMatrix();
    const localX = inv[0] * port.x + inv[4] * port.y + inv[12];
    const localY = inv[1] * port.x + inv[5] * port.y + inv[13];

    if (which === 'start') {
      const oldX = line.x1;
      const oldY = line.y1;
      if (Math.abs(oldX - localX) > 1e-6 || Math.abs(oldY - localY) > 1e-6) {
        line.updateStartPoint(localX, localY);
        return true;
      }
    } else {
      const oldX = line.x2;
      const oldY = line.y2;
      if (Math.abs(oldX - localX) > 1e-6 || Math.abs(oldY - localY) > 1e-6) {
        line.updateEndPoint(localX, localY);
        return true;
      }
    }
    return false;
  }
}
