/**
 * Salsa Animation Module — frame-by-frame animation system.
 *
 * Core components:
 *   - AnimationTimeline: frame state, playback, cel management
 *   - OnionSkinRenderer: GPU-accelerated ghost frame overlay
 *   - AnimationExporter: sprite sheet, PNG sequence, frame data export
 */

export { AnimationTimeline } from './animation-timeline';
export { OnionSkinRenderer } from './onion-skin-renderer';
export type { OnionFrame } from './onion-skin-renderer';
export { AnimationExporter } from './animation-exporter';
export type { SpriteSheetOptions, FrameExportData } from './animation-exporter';

export type {
  AnimationCel,
  AnimationLayerState,
  LayerAnimationType,
  TimelineState,
  LoopMode,
  PlaybackState,
  OnionSkinConfig,
  AnimationEvent,
  AnimationEventType,
  AnimationEventListener,
  FrameLinkAnimation,
  FrameLinkAnimationType,
  FrameLinkLoopMode,
} from './animation-types';

export { DEFAULT_ONION_SKIN, DEFAULT_FRAME_LINK_ANIMATION } from './animation-types';
