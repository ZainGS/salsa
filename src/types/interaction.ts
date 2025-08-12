export type Vec2 = [number, number];

export interface ShapeDimensions {
  x: number; y: number; width: number; height: number;
}

export type HandleSide =
  | 'top' | 'left' | 'bottom' | 'right'
  | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export const CURSORS: Record<HandleSide,
  'n-resize' | 's-resize' | 'e-resize' | 'w-resize' |
  'ne-resize' | 'nw-resize' | 'se-resize' | 'sw-resize'
> = {
  top: 'n-resize',
  bottom: 's-resize',
  left: 'w-resize',
  right: 'e-resize',
  topLeft: 'nw-resize',
  topRight: 'ne-resize',
  bottomLeft: 'sw-resize',
  bottomRight: 'se-resize',
};