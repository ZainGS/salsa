// src/services/transform-controller.ts
import { isNearRotationHandle, getScalingSide } from "../renderer/util/handles";
import { Group } from "../scene-graph/shapes/base/group";
import { Shape } from "../scene-graph/shapes/base/shape";
import { Vec2, CURSORS } from "../types/interaction";
import { InteractionService } from "./interaction-service";

export type HandleSide =
  | 'top'|'left'|'bottom'|'right'
  | 'topLeft'|'topRight'|'bottomLeft'|'bottomRight';

export type HitKind = 'none'|'move'|'rotate'|HandleSide;

export interface TransformHit {
  kind: HitKind;
  handleCenter?: Vec2; // world-space position of the handle we hit
}

export class TransformController {
  constructor(private interaction: InteractionService) {}

  // internal state
  private activeKind: HitKind = 'none';
  private activeShape: Shape | Group | null = null;
  private startMouseWorld: Vec2 | null = null;
  private startRotation = 0;
  private startDims: { x:number; y:number; w:number; h:number } | null = null;
  private scalingSide: HandleSide | null = null;

  // --- hit-testing API ---
  public hitTest(shape: Shape | Group, worldPt: Vec2): TransformHit {
    // 1) rotation handle first (uses world point and shape rotation-aware geometry)
    if (shape instanceof Shape && isNearRotationHandle(shape, worldPt)) {
      return { kind: 'rotate' };
    }
    // 2) scale handles (returns which corner/edge)
    const side = getScalingSide(shape as Shape, worldPt);
    if (side) return { kind: side, handleCenter: worldPt };
    // 3) move (inside the transformed bbox)
    if ((shape as Shape).containsPoint?.(worldPt[0], worldPt[1])) {
      return { kind: 'move' };
    }
    return { kind: 'none' };
  }

  public getCursor(kind: HitKind): string {
    if (kind === 'none') return 'default';
    if (kind === 'rotate') return 'grab';
    if (kind === 'move') return 'move';
    if (kind in CURSORS) return CURSORS[kind as HandleSide];
    return 'default';
  }

  // --- lifecycle from renderer ---
  public begin(shape: Shape | Group, kind: HitKind, startWorld: Vec2) {
    this.activeKind = kind;
    this.activeShape = shape;
    this.startMouseWorld = startWorld;

    if (shape instanceof Shape) {
      this.startRotation = shape.rotation;
      this.startDims = {
        x: shape.x, y: shape.y,
        w: shape.scaleX ?? shape.width,
        h: shape.scaleY ?? shape.height,
      };
      this.scalingSide = (['rotate','move','none'].includes(kind) ? null : kind) as HandleSide | null;
    }
  }

  public update(currentWorld: Vec2) {
    if (!this.activeShape || !this.startMouseWorld) return;

    const shape = this.activeShape as Shape; // groups flow through move path
    const dx = currentWorld[0] - this.startMouseWorld[0];
    const dy = currentWorld[1] - this.startMouseWorld[1];

    // Move
    if (this.activeKind === 'move') {
      shape.x += dx;
      shape.y += dy;
      shape.updateLocalMatrix();
      this.startMouseWorld = currentWorld;
      return;
    }

    // Rotate
    if (this.activeKind === 'rotate' && shape instanceof Shape) {
      const a0 = Math.atan2(this.startMouseWorld[1] - shape.y, this.startMouseWorld[0] - shape.x);
      const a1 = Math.atan2(currentWorld[1] - shape.y, currentWorld[0] - shape.x);
      shape.rotation = this.startRotation + (a1 - a0);
      shape.markDirty();
      return;
    }

    // Scale (rotation-aware axis projection)
    if (this.scalingSide && this.startDims && shape instanceof Shape) {
      const cos = Math.cos(shape.rotation);
      const sin = Math.sin(shape.rotation);

      // project mouse delta into rotated local axes
      const offW =  dx * cos + dy * sin;
      const offH = -dx * sin + dy * cos;

      const minW = 0.05, minH = 0.05;
      let w = this.startDims.w, h = this.startDims.h;
      let cx = this.startDims.x, cy = this.startDims.y;

      const applyX = (sign: -1|1) => {
        const nw = this.startDims!.w + sign*offW;
        const dxLocal = (nw - this.startDims!.w) / 2;
        w = Math.max(minW, nw);
        cx = this.startDims!.x + dxLocal * cos;
        cy = this.startDims!.y + dxLocal * sin;
      };
      const applyY = (sign: -1|1) => {
        const nh = this.startDims!.h + sign*offH;
        const dyLocal = (nh - this.startDims!.h) / 2;
        h = Math.max(minH, nh);
        cx = cx - dyLocal * sin;
        cy = cy + dyLocal * cos;
      };

      switch (this.scalingSide) {
        case 'left':        applyX(-1); break;
        case 'right':       applyX(+1); break;
        case 'top':         applyY(+1); break;
        case 'bottom':      applyY(-1); break;
        case 'topLeft':     applyX(-1); applyY(+1); break;
        case 'topRight':    applyX(+1); applyY(+1); break;
        case 'bottomLeft':  applyX(-1); applyY(-1); break;
        case 'bottomRight': applyX(+1); applyY(-1); break;
      }

      shape.scaleX = w;
      shape.scaleY = h;
      shape.x = cx;
      shape.y = cy;
      shape.updateLocalMatrix();
      shape.markDirty();
      return;
    }
  }

  public end() {
    this.activeKind = 'none';
    this.activeShape = null;
    this.startMouseWorld = null;
    this.startDims = null;
    this.scalingSide = null;
  }
}