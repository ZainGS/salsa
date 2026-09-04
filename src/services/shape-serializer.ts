import { Node } from "../scene-graph/shapes/base/node";
import { Scribble } from "../scene-graph/shapes/scribble";
import { Highlight } from "../scene-graph/shapes/highlight";
import { Pattern } from "../scene-graph/shapes/pattern";
import { Stamp } from "../scene-graph/shapes/stamp";
import { SDFText } from "../scene-graph/shapes/sdf-text/sdf-text";
import { TextEffectEngine } from "../renderer/raster/effects/text-effect-engine";
import type { ShapeFactory } from "../scene-graph/core/shape-factory";
import type { EraserService } from "./drawing/eraser-service";
import type { PatternDrawingService } from "./drawing/pattern-drawing-service";
import type { StampDrawingService } from "./drawing/stamp-drawing-service";
import type { SdfTextDrawingService } from "./drawing/sdftext-drawing-service";
import type { WebGPURenderer } from "../renderer/core/webgpu-renderer";
import type { InteractionService } from "./interaction-service";

/** Collaborators needed to reconstruct a 2D shape from its toJSON data (the drawing services own the atlases /
 *  engines the shapes sample). ShapeManager builds this from its own fields. */
export interface Shape2DRestoreDeps {
    shapeFactory: ShapeFactory;
    eraserService: EraserService;
    patternDrawingService: PatternDrawingService;
    stampDrawingService: StampDrawingService;
    sdfTextDrawingService: SdfTextDrawingService;
    getTextEffectEngine(): TextEffectEngine | null;
    webgpuRenderer: WebGPURenderer;
    interactionService: InteractionService;
}

/**
 * Reconstruct a 2D LEAF shape (Rectangle … Panel Layout) from its serialized `data`. Extracted verbatim from
 * ShapeManager.recreateNode — the switch bodies are unchanged (this.* → deps.*). Returns `null` for any type that
 * is NOT a 2D leaf (Group / 3D nodes / unknown); the caller (recreateNode) handles those (they recurse + couple to
 * scene3d) and applies the common post-processing (id / transform / children) to whatever this returns.
 */
export function recreate2DShape(data: any, deps: Shape2DRestoreDeps): Node | null {
    let node: Node;
    switch (data.type) {
            case "Rectangle":
                node = deps.shapeFactory.createRectangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Circle":
                node = deps.shapeFactory.createCircle(
                    data.x, data.y, data.radius ?? data.width, // Assuming `width` is used as radius
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Triangle":
                node = deps.shapeFactory.createTriangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "InvertedTriangle":
                node = deps.shapeFactory.createInvertedTriangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Diamond":
                node = deps.shapeFactory.createDiamond(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Line":
                const line = deps.shapeFactory.createLine(
                    data.x1, data.y1, data.x2, data.y2, data.strokeColor, data.strokeWidth
                );
                if (data.x1 === data.x2 && data.y1 === data.y2) {
                    line.updateEndPoint(data.x2 + 1e-6, data.y2); // avoid degenerate on load
                }
                if (data.arrowStart) line.arrowStart = data.arrowStart;
                if (data.arrowEnd) line.arrowEnd = data.arrowEnd;
                if (data.arrowSize != null) line.arrowSize = data.arrowSize;
                if (data.startBinding) line.startBinding = data.startBinding;
                if (data.endBinding) line.endBinding = data.endBinding;
                node = line;
                break;
            case "Scribble":
                node = deps.shapeFactory.createScribble(
                    data.x, data.y, data.strokeColor, data.strokeWidth
                );
                (node as Scribble).points = data.points;
                (node as Scribble).wasCommitted = false;
                (node as Scribble).isStaging = false;
                deps.eraserService.scribbles.push(node as Scribble);
                break;
            case "Highlight": 
                node = deps.shapeFactory.createHighlight(
                    data.points[0].x, data.points[0].y, data.strokeColor, data.strokeWidth
                );
                (node as Highlight).points = data.points;
                deps.eraserService.scribbles.push(node as Highlight);
                break;
            case "Pattern":
						node = deps.shapeFactory.createPattern(
								data.x1, data.y1, data.x2, data.y2,
								data.strokeColor, data.strokeWidth,
								data.textureKey,
								deps.patternDrawingService.device
						);
						
						const pattern = node as Pattern;
						const patternAtlas = deps.patternDrawingService.getAtlas();
						
						// Since texture was pre-loaded, get the current layer
						const patternLayer = patternAtlas.getLayer(data.textureKey);
						
						// Use the CURRENT atlas layer, not saved data
						pattern.layerIndex = patternLayer >= 0 ? patternLayer : 0;
						pattern.atlasWidth = patternAtlas.getWidth();
						
						if (patternLayer < 0) {
								console.warn(`Pattern texture not found in atlas: ${data.textureKey}`);
						}
						
						break;
						case "Stamp":
							node = deps.shapeFactory.createStamp(
									data.x, data.y,
									data.width, data.height,
									data.textureKey,
									data.fillColor || { r: 1, g: 1, b: 1, a: 1 }
							);
							
							const stamp = node as Stamp;
							const atlas = deps.stampDrawingService.getAtlas();
							
							// Since texture was pre-loaded, get the current layer
							const layer = atlas.getLayer(data.textureKey);
							
							// Use the CURRENT atlas layer, not saved data
							stamp.layerIndex = layer >= 0 ? layer : 0;
							stamp.atlasWidth = atlas.getWidth();
							stamp.atlasHeight = atlas.getHeight();
							
							if (layer < 0) {
									console.warn(`Stamp texture not found in atlas: ${data.textureKey}`);
							}
							
							break;
            case "SDFText":
                node = deps.shapeFactory.createSDFText(
                    data.x, 
                    data.y, 
                    data.text, 
                    data.fontSize,
                    deps.sdfTextDrawingService.getSDFAtlas(),
                    data.fillColor || data.strokeColor, // SDFText uses strokeColor primarily
                    data.font
                );
                const sdfTextNode = node as SDFText;
                sdfTextNode.lineHeight = data.lineHeight ?? sdfTextNode.lineHeight;
                sdfTextNode.setText(data.text ?? "TEST");
                sdfTextNode.sdfThreshold = data.sdfThreshold ?? 0.5;
                sdfTextNode.outlineColor = data.outlineColor ?? { r: 0, g: 0, b: 0, a: 0 };
                sdfTextNode.smoothing = data.smoothing ?? 1;
                sdfTextNode.outlineWidth = data.outlineWidth ?? 0;
                if (data.writingMode) sdfTextNode.writingMode = data.writingMode;
                if (data.maxWidth != null && data.maxWidth > 0) {
                    sdfTextNode.setMaxWidth(data.maxWidth);
                }
                sdfTextNode.refreshText();
                break;
            case "Sticky Note": 
                const note = deps.shapeFactory.createStickyNote(
                    data.x, data.y, data.text ?? "New note", data.color ?? {r:1,g:.98,b:.65,a:1}, data.signatureText,
										data.font, data.fontSize, data.lineHeight
                );
                note.fixedWidth = data.fixedWidth ?? true;
                if (data.targetWidth) note.setWidth(data.targetWidth);
                node = note;
                break;
            case "Polygon":
                node = deps.shapeFactory.createPolygon(
                    data.points, data.fillColor, data.strokeColor, data.strokeWidth
                );
                if (data.presetTag) (node as any).presetTag = data.presetTag;
                break;
            case "Speech Balloon": {
                const balloon = deps.shapeFactory.createSpeechBalloon(data.x, data.y, {
                    text: data.text,
                    font: data.font,
                    fontSize: data.fontSize,
                    lineHeight: data.lineHeight,
                    writingMode: data.writingMode,
                    textColor: data.textColor,
                    fillColor: data.fillColor,
                    strokeColor: data.strokeColor,
                    strokeWidth: data.strokeWidth,
                    tailSide: data.tailSide,
                    tailPosition: data.tailPosition,
                    tailLength: data.tailLength,
                    tailWidth: data.tailWidth,
                    showTail: data.showTail,
                    style: data.balloonStyle,
                    minWidth: data.minWidth,
                    minHeight: data.minHeight,
                    maxWidth: data.maxWidth,
                });
                node = balloon;
                break;
            }
            case "LiveText": {
                const ltOpts = data.liveTextOptions ?? {};
                const node2 = deps.shapeFactory.createLiveText(data.x ?? 0, data.y ?? 0, {
                    text: ltOpts.text ?? '',
                    font: ltOpts.font,
                    fontSize: ltOpts.fontSize,
                    color: ltOpts.color,
                    bold: ltOpts.bold,
                    italic: ltOpts.italic,
                    writingMode: ltOpts.writingMode,
                    maxWidth: ltOpts.maxWidth,
                    lineHeight: ltOpts.lineHeight,
                    padding: ltOpts.padding,
                    backgroundColor: ltOpts.backgroundColor,
                    align: ltOpts.align,
                    frameWidth: ltOpts.frameWidth,
                    frameHeight: ltOpts.frameHeight,
                    userScaleX: ltOpts.userScaleX,
                    userScaleY: ltOpts.userScaleY,
                    arcAngle: ltOpts.arcAngle,
                    effects: ltOpts.effects,
                });
                // Wire up the TextEffectEngine so the node can render
                const engine = deps.getTextEffectEngine();
                if (engine) node2.setEngine(engine);

                // Compute worldUnitsPerPixel (same as createLiveText)
                const illBounds2 = deps.webgpuRenderer?.getIllustrationBounds?.();
                const pixelSize2 = deps.webgpuRenderer?.getIllustrationPixelSize?.();
                const canvas2 = deps.interactionService?.canvas;
                if (illBounds2 && pixelSize2) {
                    node2.worldUnitsPerPixel = illBounds2.width / pixelSize2.w;
                } else if (canvas2) {
                    node2.worldUnitsPerPixel = 2 / canvas2.height;
                }
                node2.applyInitialSize();

                // Init DOM element for HTML-in-Canvas
                if (canvas2 && TextEffectEngine.htmlInCanvasAvailable()) {
                    if (!canvas2.hasAttribute('layoutsubtree')) {
                        canvas2.setAttribute('layoutsubtree', '');
                    }
                    node2.initDomElement(canvas2);
                    TextEffectEngine.requestPaint(canvas2);
                }

                // Capture initial texture so dimensions are correct
                node2.updateTexture();

                node = node2;
                break;
            }
            case "Panel Layout": {
                const layout = deps.shapeFactory.createPanelLayout(
                    data.x, data.y,
                    data.pageWidth ?? 2, data.pageHeight ?? 3,
                    {
                        rows: data.rows,
                        cols: data.cols,
                        gutterWidth: data.gutterWidth,
                        bleedMargin: data.bleedMargin,
                        borderWidth: data.borderWidth,
                        borderColor: data.borderColor,
                        backgroundColor: data.backgroundColor,
                        showBleedGuides: data.showBleedGuides,
                        showGutterGuides: data.showGutterGuides,
                        panels: data.panels,
                        template: data.templateName,
                    },
                );
                node = layout;
                break;
            }
            default:
                return null;
        }
    return node;
}
