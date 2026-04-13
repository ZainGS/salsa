/**
 * Animation Types — core interfaces for Salsa's frame-by-frame animation system.
 *
 * Design principle: an animation is a timeline of frames. Each layer can be either
 * a STATIC layer (one texture, visible on all frames — e.g. a background) or an
 * ANIMATED layer (one texture per cel, mapped to specific frames).
 *
 * Terminology:
 *   - Frame: a point in time on the timeline (1-indexed)
 *   - Cel: a single drawing on an animated layer (has a texture + frame range)
 *   - Hold frame: a cel that spans multiple frames (drawn once, displayed for N frames)
 *   - Blank frame: a frame with no cel (transparent)
 *   - Keyframe: a cel marked as a "key" drawing (for animator workflow)
 *   - Inbetween: a cel marked as an intermediate drawing between keys
 */

// ─── Cel (single drawing on one frame range) ───────────────────────

export interface AnimationCel {
  /** Unique cel identifier. */
  id: string;
  /** The frame number where this cel starts being displayed (1-indexed). */
  startFrame: number;
  /** Number of frames this cel is held for (1 = single frame, >1 = hold). */
  duration: number;
  /** The GPU texture containing this cel's pixel data. */
  texture: GPUTexture;
  /** Whether this is a key drawing or an inbetween. */
  celType: 'key' | 'inbetween';
}

// ─── Layer animation state ──────────────────────────────────────────

export type LayerAnimationType = 'static' | 'animated';

export interface AnimationLayerState {
  /** Whether this layer participates in animation. */
  type: LayerAnimationType;
  /** Ordered array of cels (only used when type === 'animated'). */
  cels: AnimationCel[];
}

// ─── Timeline ───────────────────────────────────────────────────────

export type LoopMode = 'none' | 'loop' | 'ping-pong';

export type PlaybackState = 'stopped' | 'playing' | 'paused';

export interface TimelineState {
  /** Total number of frames in the timeline. */
  frameCount: number;
  /** Current frame (1-indexed). */
  currentFrame: number;
  /** Frames per second. Common: 8 (simple), 12 (anime on 2s), 24 (full). */
  fps: number;
  /** Playback loop mode. */
  loopMode: LoopMode;
  /** Current playback state. */
  playbackState: PlaybackState;
  /** Playback range start (for looping a section). 1-indexed. */
  playRangeStart: number;
  /** Playback range end. */
  playRangeEnd: number;
}

// ─── Onion Skin ─────────────────────────────────────────────────────

export interface OnionSkinConfig {
  /** Enable onion skinning. */
  enabled: boolean;
  /** Number of previous frames to show. */
  framesBefore: number;
  /** Number of next frames to show. */
  framesAfter: number;
  /** Opacity of the closest onion frame (fades with distance). 0-1. */
  opacity: number;
  /** Tint color for previous frames [r, g, b]. Default: red-ish. */
  tintBefore: [number, number, number];
  /** Tint color for next frames [r, g, b]. Default: green/blue-ish. */
  tintAfter: [number, number, number];
}

export const DEFAULT_ONION_SKIN: OnionSkinConfig = {
  enabled: false,
  framesBefore: 2,
  framesAfter: 1,
  opacity: 0.3,
  tintBefore: [1.0, 0.2, 0.2],  // red
  tintAfter: [0.2, 0.5, 1.0],   // blue
};

// ─── Frame Link Animation (procedural per-layer displacement) ───────

/** Displacement animation type applied at composite time. */
export type FrameLinkAnimationType =
  | 'wave'        // Sinusoidal displacement along a direction
  | 'shake'       // Random whole-layer jitter per frame
  | 'ripple'      // Radial waves from a center point
  | 'noise'       // Simplex/value noise displacement (organic)
  | 'turbulence'; // Multi-octave layered noise

/** Loop mode for the displacement animation. */
export type FrameLinkLoopMode =
  | 'free'         // Phase advances at constant speed forever
  | 'loop-to-fit'; // One full cycle maps exactly to the cel's frame range

/**
 * Procedural UV displacement applied to a layer at composite time.
 * Completely stateless — no per-frame textures are baked. The shader
 * evaluates the displacement formula for the current frame on the fly.
 */
export interface FrameLinkAnimation {
  /** Master enable/disable. */
  enabled: boolean;

  /** Displacement type. */
  type: FrameLinkAnimationType;

  /** Displacement strength in texels (0 = no effect, 50 = dramatic). Default: 10. */
  amplitude: number;

  /** Spatial frequency — waves per texture width. Higher = more ripples. Default: 3.0. */
  frequency: number;

  /** Phase advance per frame — controls animation speed. Default: 0.15. */
  speed: number;

  /** Wave propagation direction in degrees (0 = right, 90 = down). Default: 0. */
  direction: number;

  /** Starting phase offset in radians. Default: 0. */
  phase: number;

  /** How the animation cycles. Default: 'free'. */
  loopMode: FrameLinkLoopMode;

  // ── Per-type parameters ──

  /** Ripple center X in normalized coords (0–1). Default: 0.5. */
  rippleCenterX: number;
  /** Ripple center Y in normalized coords (0–1). Default: 0.5. */
  rippleCenterY: number;

  /** Noise octaves for turbulence (1–4). Higher = more detail, more GPU cost. Default: 2. */
  noiseOctaves: number;
  /** Noise lacunarity — frequency multiplier per octave. Default: 2.0. */
  noiseLacunarity: number;
  /** Noise persistence — amplitude multiplier per octave (0–1). Default: 0.5. */
  noisePersistence: number;

  /** Shake randomness seed offset. Changes produce different jitter patterns. Default: 0. */
  shakeSeed: number;

  /** Whether displacement affects X axis. Default: true. */
  displaceX: boolean;
  /** Whether displacement affects Y axis. Default: false. */
  displaceY: boolean;
}

/** Default FrameLinkAnimation config. */
export const DEFAULT_FRAME_LINK_ANIMATION: FrameLinkAnimation = {
  enabled: false,
  type: 'wave',
  amplitude: 10,
  frequency: 3.0,
  speed: 0.15,
  direction: 0,
  phase: 0,
  loopMode: 'free',
  rippleCenterX: 0.5,
  rippleCenterY: 0.5,
  noiseOctaves: 2,
  noiseLacunarity: 2.0,
  noisePersistence: 0.5,
  shakeSeed: 0,
  displaceX: true,
  displaceY: false,
};

// ─── Events ─────────────────────────────────────────────────────────

export type AnimationEventType =
  | 'frame-changed'
  | 'playback-state-changed'
  | 'timeline-changed'
  | 'cel-added'
  | 'cel-removed'
  | 'layer-type-changed'
  | 'onion-skin-changed';

export interface AnimationEvent {
  type: AnimationEventType;
  frame?: number;
  layerId?: string;
  celId?: string;
}

export type AnimationEventListener = (event: AnimationEvent) => void;
