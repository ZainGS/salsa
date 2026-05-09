# Frogmarks → ShapeManager Delegate Migration Guide

> **Date:** April 14, 2026  
> **Purpose:** Migrate existing Frogmarks `shapeManager.methodName()` calls to the new organized delegate structure.  
> **Backward Compatibility:** ALL legacy methods still work — this migration is **not urgent** but should be done incrementally.

---

## Architecture Overview

ShapeManager is now a **thin façade**. Six domain-specific delegate managers hold the actual logic:

| Delegate Property | Class | File | Domain |
|---|---|---|---|
| `shapeManager.raster` | `RasterManager` | `src/services/managers/raster-manager.ts` | Raster drawing, selection, layers, brushes, dithering, frame-link |
| `shapeManager.text` | `TextManager` | `src/services/managers/text-manager.ts` | SDF text, LiveText, text effects, custom shaders |
| `shapeManager.animation` | `AnimationManager` | `src/services/managers/animation-manager.ts` | Timeline, playback, cels, onion skinning |
| `shapeManager.scene3d` | `Scene3DManager` | `src/services/managers/scene3d-manager.ts` | 3D camera, meshes, PS1 config, lighting |
| `shapeManager.drawing` | `DrawingToolManager` | `src/services/managers/drawing-tool-manager.ts` | Vector tools, shape creation, preview, image import |
| `shapeManager.persist` | `PersistenceManager` | `src/services/managers/persistence-manager.ts` | Auto-save, load/save documents, OPFS |

The remaining methods stay on ShapeManager directly:
- **Core scene ops:** `setBackgroundColor`, `getBackgroundColor`, `setDotColor`, `getDotColor`, `setSelectedNode`, `addSelectedNode`, `clearSelectedNodes`, `deselectNode`, `getLayers`, `addLayer`, `deleteLayer`, `selectLayer`, `getSelectedLayerId`, `setNodeFillColor`, `getNodeFillColor`, `getNodePosition`, `setNodePosition`, `setNodeVisibility`, `setNodeLocked`, `setNodeName`, `getNodeById`, `deleteSelectedShapes`, `clear`
- **Connector:** `getConnectorService`, `setSnapThreshold`, `findSnapTarget`, `bindLineStart`, `bindLineEnd`, `unbindLineStart`, `unbindLineEnd`, `updateConnectors`, `getAllConnectionPoints`, `getShapeConnectionPoints`, `setDefaultArrowheads`
- **SpeechBalloon:** `createSpeechBalloon`, `getSpeechBalloon`, `setSpeechBalloonText`, `setSpeechBalloonWritingMode`, `setSpeechBalloonTail`, `setSpeechBalloonTailTarget`, `setSpeechBalloonStyle`, `getSpeechBalloonTailPoints`
- **PanelLayout:** `createPanelLayout`, `createPanelLayoutForIllustration`, `getPanelLayout`, `applyPanelTemplate`, `splitPanelHorizontal`, `splitPanelVertical`, `mergePanels`, `removePanel`, `setPanelReadingOrder`, `setPanelGutter`, `setPanelBleed`, `getPanelBleedGuide`, `getPanelGutterGuides`, `getPanelList`
- **Serialization:** `getSceneGraphJSON`, `getSceneGraphJSONWithRasterData`, `setSceneGraphJSON`, `updateSceneGraph`, `waitForFrameSettled`, `captureThumbnailBlob`, `exportRasterLayerToBlob`, `exportAllRasterLayersAsBlobs`, `setIllustrationMode`, `getIllustrationMode`, `setIllustrationBounds`, `setBackgroundPatternFixed`

---

## Migration Pattern

Every legacy method still works. Migration is a **find-and-replace** that changes the call path:

```ts
// BEFORE (legacy — still works, just not organized)
shapeManager.enableRasterDrawing();
shapeManager.setRasterBrushSize(10);

// AFTER (new delegate path)
shapeManager.raster.enableDrawing();
shapeManager.raster.setBrushSize(10);
```

---

## Complete Migration Table

### `shapeManager.raster` — Raster Operations

| Legacy Call | New Call | Notes |
|---|---|---|
| `enableRasterDrawing()` | `raster.enableDrawing()` | |
| `disableRasterDrawing()` | `raster.disableDrawing()` | |
| `enableRasterSelection(tool)` | `raster.enableSelection(tool)` | |
| `disableRasterSelection()` | `raster.disableSelection()` | |
| `enableRasterMove()` | `raster.enableMove()` | |
| `disableRasterMove()` | `raster.disableMove()` | |
| `enableRasterTool()` | `raster.enableTool()` | |
| `disableRasterTool()` | `raster.disableTool()` | |
| `enableRasterEraserTool()` | `raster.enableEraserTool()` | |
| `enableRasterClearEraserTool()` | `raster.enableClearEraserTool()` | |
| `disableRasterEraserTool()` | `raster.disableEraserTool()` | |
| `setRasterBrushSize(size)` | `raster.setBrushSize(size)` | |
| `setRasterBrushColor(color)` | `raster.setBrushColor(color)` | |
| `onRasterStrokeStart(cb)` | `raster.onStrokeStart(cb)` | |
| `onRasterStrokeUpdate(cb)` | `raster.onStrokeUpdate(cb)` | |
| `onRasterStrokeEnd(cb)` | `raster.onStrokeEnd(cb)` | |
| `getRasterTextureSize()` | `raster.getTextureSize()` | |
| `rasterUndo()` | `raster.undo()` | |
| `rasterRedo()` | `raster.redo()` | |
| `rasterPushSnapshot()` | `raster.pushSnapshot()` | |
| `pushSnapshotForRasterLayer(id)` | `raster.pushSnapshotForLayer(id)` | |
| `undoRasterLayer(id)` | `raster.undoLayer(id)` | |
| `redoRasterLayer(id)` | `raster.redoLayer(id)` | |
| `getRasterLayers()` | `raster.getLayers()` | |
| `addRasterLayer(name)` | `raster.addLayer(name)` | |
| `deleteRasterLayer(id)` | `raster.deleteLayer(id)` | |
| `selectRasterLayer(id)` | `raster.selectLayer(id)` | |
| `setRasterLayerVisibility(id, v)` | `raster.setLayerVisibility(id, v)` | |
| `setRasterLayerBlendMode(id, m)` | `raster.setLayerBlendMode(id, m)` | |
| `setRasterLayerOpacity(id, o)` | `raster.setLayerOpacity(id, o)` | |
| `setRasterLayerClipping(id, c)` | `raster.setLayerClipping(id, c)` | |
| `setRasterLayerLockTransparency(id, l)` | `raster.setLayerLockTransparency(id, l)` | |
| `reorderRasterLayers(ids)` | `raster.reorderLayers(ids)` | |
| `ShapeManager.LayerBlendMode` | `RasterManager.LayerBlendMode` | Static access |
| `rasterSelectRect(x,y,w,h,f)` | `raster.selectRect(x,y,w,h,f)` | |
| `rasterSelectEllipse(x,y,w,h,f)` | `raster.selectEllipse(x,y,w,h,f)` | |
| `rasterSelectLasso(points)` | `raster.selectLasso(points)` | |
| `rasterSelectAll()` | `raster.selectAll()` | |
| `rasterDeselectAll()` | `raster.deselectAll()` | |
| `rasterInvertSelection()` | `raster.invertSelection()` | |
| `rasterDeleteSelection()` | `raster.deleteSelection()` | |
| `rasterCutSelection()` | `raster.cutSelection()` | |
| `rasterCopySelection()` | `raster.copySelection()` | |
| `rasterPaste()` | `raster.paste()` | |
| `rasterBeginTransform()` | `raster.beginTransform()` | |
| `rasterUpdateTransform(...)` | `raster.updateTransform(...)` | |
| `rasterCommitTransform()` | `raster.commitTransform()` | |
| `rasterCancelTransform()` | `raster.cancelTransform()` | |
| `getRasterSelectionInfo()` | `raster.getSelectionInfo()` | |
| `setRasterSelectionTool(t)` | `raster.setSelectionTool(t)` | |
| `setRasterSelectionMode(m)` | `raster.setSelectionMode(m)` | |
| `getRasterSelectionMode()` | `raster.getSelectionMode()` | |
| `rasterSelectMagicWand(...)` | `raster.selectMagicWand(...)` | |
| `rasterSelectByColor(...)` | `raster.selectByColor(...)` | |
| `setMagicWandOptions(opts)` | `raster.setMagicWandOptions(opts)` | |
| `rasterFlipHorizontal()` | `raster.flipHorizontal()` | |
| `rasterFlipVertical()` | `raster.flipVertical()` | |
| `rasterRotate(deg)` | `raster.rotate(deg)` | |
| `rasterScale(sx, sy)` | `raster.scale(sx, sy)` | |
| `getRasterTexturesForComposition()` | `raster.getTexturesForComposition()` | |
| `floodFill(x,y,color,opts)` | `raster.floodFill(x,y,color,opts)` | |
| `worldToTexel(wx,wy)` | `raster.worldToTexel(wx,wy)` | |
| `floodFillWorld(wx,wy,c,opts)` | `raster.floodFillWorld(wx,wy,c,opts)` | |
| `fillSelection(color)` | `raster.fillSelection(color)` | |
| `enableRasterText()` | `raster.enableText()` | |
| `disableRasterText()` | `raster.disableText()` | |
| `getRasterTextState()` | `raster.getTextState()` | |
| `updateRasterTextProperties(p)` | `raster.updateTextProperties(p)` | |
| `commitRasterText()` | `raster.commitText()` | |
| `cancelRasterText()` | `raster.cancelText()` | |
| `onRasterTextStateChanged(cb)` | `raster.onTextStateChanged(cb)` | |
| `getRasterPaintEngine()` | `raster.getPaintEngine()` | |
| `getBrushPresets()` | `raster.getBrushPresets()` | |
| `getBrushPreset(id)` | `raster.getBrushPreset(id)` | |
| `setActiveBrushPreset(id)` | `raster.setActiveBrushPreset(id)` | |
| `getActiveBrushPresetId()` | `raster.getActiveBrushPresetId()` | |
| `importBrushPreset(json)` | `raster.importBrushPreset(json)` | |
| `exportBrushPreset(id)` | `raster.exportBrushPreset(id)` | |
| `importBrushPresets(json)` | `raster.importBrushPresets(json)` | |
| `exportAllBrushPresets()` | `raster.exportAllBrushPresets()` | |
| `registerBrushPreset(p)` | `raster.registerBrushPreset(p)` | |
| `deleteBrushPreset(id)` | `raster.deleteBrushPreset(id)` | |
| `updateBrushPreset(id, c)` | `raster.updateBrushPreset(id, c)` | |
| `setBrushDualBrush(id, s)` | `raster.setDualBrush(id, s)` | |
| `setBrushColorJitter(id, j)` | `raster.setColorJitter(id, j)` | |
| `setBrushWetEdges(id, s)` | `raster.setWetEdges(id, s)` | |
| `ShapeManager.DualBrushBlendOp` | `RasterManager.DualBrushBlendOp` | Static |
| `setBrushStrokeTexture(id, s)` | `raster.setStrokeTexture(id, s)` | |
| `setBrushGrain(s)` | `raster.setBrushGrain(s)` | |
| `getBrushGrain()` | `raster.getBrushGrain()` | |
| `setCanvasGrain(s)` | `raster.setBrushGrain(s)` | Deprecated alias removed |
| `getCanvasGrain()` | `raster.getBrushGrain()` | Deprecated alias removed |
| `setBrushStabilization(id, s)` | `raster.setBrushStabilization(id, s)` | |
| `getBrushStabilization(id)` | `raster.getBrushStabilization(id)` | |
| `setActiveStabilization(s)` | `raster.setActiveStabilization(s)` | |
| `getActiveStabilization()` | `raster.getActiveStabilization()` | |
| `setPaperGrain(s)` | `raster.setPaperGrain(s)` | |
| `getPaperGrain()` | `raster.getPaperGrain()` | |
| `getAvailableGrainTypes()` | `raster.getAvailableGrainTypes()` | |
| `setDitherConfig(c)` | `raster.setDitherConfig(c)` | |
| `getDitherConfig()` | `raster.getDitherConfig()` | |
| `setDitherEnabled(e)` | `raster.setDitherEnabled(e)` | |
| `setDitherAlgorithm(a)` | `raster.setDitherAlgorithm(a)` | |
| `setDitherStrength(s)` | `raster.setDitherStrength(s)` | |
| `setDitherColorLevels(l)` | `raster.setDitherColorLevels(l)` | |
| `setDitherPatternScale(s)` | `raster.setDitherPatternScale(s)` | |
| `setDitherBayerLevel(l)` | `raster.setDitherBayerLevel(l)` | |
| `setDitherHalftoneAngle(d)` | `raster.setDitherHalftoneAngle(d)` | |
| `setDitherHalftoneFrequency(f)` | `raster.setDitherHalftoneFrequency(f)` | |
| `setDitherPerChannel(p)` | `raster.setDitherPerChannel(p)` | |
| `ShapeManager.DitherAlgorithms` | `RasterManager.DitherAlgorithms` | Static |
| `ShapeManager.isErrorDiffusion(a)` | `RasterManager.isErrorDiffusion(a)` | Static |
| `setLayerDitherConfig(id, c)` | `raster.setLayerDitherConfig(id, c)` | |
| `getLayerDitherConfig(id)` | `raster.getLayerDitherConfig(id)` | |
| `setDitherColorMode(m)` | `raster.setDitherColorMode(m)` | |
| `setDitherForegroundColor(r,g,b,a)` | `raster.setDitherForegroundColor(r,g,b,a)` | |
| `setDitherBackgroundColor(r,g,b,a)` | `raster.setDitherBackgroundColor(r,g,b,a)` | |
| `swapDitherColors()` | `raster.swapDitherColors()` | |
| `setDitherInvertPattern(i)` | `raster.setDitherInvertPattern(i)` | |
| `setDitherTintOpacity(o)` | `raster.setDitherTintOpacity(o)` | |
| `setDitherDuotoneBias(b)` | `raster.setDitherDuotoneBias(b)` | |
| `setLayerFrameLinkAnimation(id, c)` | `raster.setLayerFrameLinkAnimation(id, c)` | |
| `getLayerFrameLinkAnimation(id)` | `raster.getLayerFrameLinkAnimation(id)` | |
| `getDefaultFrameLinkAnimation()` | `raster.getDefaultFrameLinkAnimation()` | |
| `setLayerFrameLinkEnabled(id, e)` | `raster.setLayerFrameLinkEnabled(id, e)` | |
| `setLayerFrameLinkType(id, t)` | `raster.setLayerFrameLinkType(id, t)` | |
| `setLayerFrameLinkAmplitude(id, a)` | `raster.setLayerFrameLinkAmplitude(id, a)` | |
| `setLayerFrameLinkFrequency(id, f)` | `raster.setLayerFrameLinkFrequency(id, f)` | |
| `setLayerFrameLinkSpeed(id, s)` | `raster.setLayerFrameLinkSpeed(id, s)` | |
| `setLayerFrameLinkDirection(id, d)` | `raster.setLayerFrameLinkDirection(id, d)` | |
| `setLayerFrameLinkPhase(id, p)` | `raster.setLayerFrameLinkPhase(id, p)` | |
| `setLayerFrameLinkLoopMode(id, m)` | `raster.setLayerFrameLinkLoopMode(id, m)` | |
| `setLayerFrameLinkAxes(id, x, y)` | `raster.setLayerFrameLinkAxes(id, x, y)` | |
| `setLayerFrameLinkRippleCenter(id, x, y)` | `raster.setLayerFrameLinkRippleCenter(id, x, y)` | |
| `setLayerFrameLinkNoiseParams(id, o, l, p)` | `raster.setLayerFrameLinkNoiseParams(id, o, l, p)` | |

---

### `shapeManager.text` — Text Operations

| Legacy Call | New Call | Notes |
|---|---|---|
| `enableSDFTextDrawing()` | `text.enableSDFTextDrawing()` | Same name |
| `disableSDFTextDrawing()` | `text.disableSDFTextDrawing()` | Same name |
| `isSDFTextDrawingInProgress()` | `text.isSDFTextDrawingInProgress()` | |
| `setSDFTextColor(c)` | `text.setSDFTextColor(c)` | |
| `setSDFTextOutlineColor(c)` | `text.setSDFTextOutlineColor(c)` | |
| `setSDFTextFontSize(s)` | `text.setSDFTextFontSize(s)` | |
| `setSDFTextFont(f)` | `text.setSDFTextFont(f)` | |
| `setSDFTextThreshold(t)` | `text.setSDFTextThreshold(t)` | |
| `setSDFTextSmoothing(s)` | `text.setSDFTextSmoothing(s)` | |
| `setSDFTextOutlineWidth(w)` | `text.setSDFTextOutlineWidth(w)` | |
| `setSDFTextMaxWidth(w)` | `text.setSDFTextMaxWidth(w)` | |
| `updateSDFText(id, p)` | `text.updateSDFText(id, p)` | |
| `isInputActive()` | `text.isInputActive()` | |
| `getEditingLiveTextId()` | `text.getEditingLiveTextId()` | |
| `captureTextToTexture(c)` | `text.captureTextToTexture(c)` | |
| `isHtmlInCanvasAvailable()` | `text.isHtmlInCanvasAvailable()` | |
| `getHtmlInCanvasMode()` | `text.getHtmlInCanvasMode()` | |
| `setupHtmlInCanvas(cb)` | `text.setupHtmlInCanvas(cb)` | |
| `requestHtmlPaint()` | `text.requestHtmlPaint()` | |
| `captureElementToTexture(el)` | `text.captureElementToTexture(el)` | |
| `applyTextEffect(src, fx, p)` | `text.applyTextEffect(src, fx, p)` | |
| `applyTextEffectChain(src, fxs)` | `text.applyTextEffectChain(src, fxs)` | |
| `validateCustomShader(code, raw)` | `text.validateCustomShader(code, raw)` | |
| `setCustomShader(id, code, raw, p)` | `text.setCustomShader(id, code, raw, p)` | |
| `removeCustomShader(id)` | `text.removeCustomShader(id)` | |
| `setCustomShaderParams(id, p)` | `text.setCustomShaderParams(id, p)` | |
| `createEffectedText(tc, fxs)` | `text.createEffectedText(tc, fxs)` | |
| `stampEffectedText(dx,dy,tc,fxs)` | `text.stampEffectedText(dx,dy,tc,fxs)` | |
| `createLiveText(x, y, opts)` | `text.createLiveText(x, y, opts)` | |
| `setLiveTextEffects(id, fxs)` | `text.setLiveTextEffects(id, fxs)` | |
| `setLiveTextContent(id, t)` | `text.setLiveTextContent(id, t)` | |
| `setLiveTextStyle(id, s)` | `text.setLiveTextStyle(id, s)` | |
| `beginLiveTextEditing(id)` | `text.beginLiveTextEditing(id)` | |
| `endLiveTextEditing(id)` | `text.endLiveTextEditing(id)` | |
| `flattenLiveText(id)` | `text.flattenLiveText(id)` | |
| `getLiveTextNode(id)` | `text.getLiveTextNode(id)` | |

---

### `shapeManager.animation` — Timeline & Cel Operations

| Legacy Call | New Call | Notes |
|---|---|---|
| `setAnimationEnabled(e)` | `animation.setEnabled(e)` | Shortened |
| `isAnimationEnabled()` | `animation.isEnabled()` | Shortened |
| `setCurrentFrame(f)` | `animation.setCurrentFrame(f)` | |
| `getCurrentFrame()` | `animation.getCurrentFrame()` | |
| `getFrameCount()` | `animation.getFrameCount()` | |
| `setFrameCount(c)` | `animation.setFrameCount(c)` | |
| `setPlayRange(s, e)` | `animation.setPlayRange(s, e)` | |
| `getPlayRange()` | `animation.getPlayRange()` | |
| `getFps()` | `animation.getFps()` | |
| `setFps(f)` | `animation.setFps(f)` | |
| `addFrames(c)` | `animation.addFrames(c)` | |
| `insertFrame(at)` | `animation.insertFrame(at)` | |
| `deleteFrame(at)` | `animation.deleteFrame(at)` | |
| `nextFrame()` | `animation.nextFrame()` | |
| `prevFrame()` | `animation.prevFrame()` | |
| `play()` | `animation.play()` | |
| `pause()` | `animation.pause()` | |
| `stopPlayback()` | `animation.stopPlayback()` | |
| `togglePlayPause()` | `animation.togglePlayPause()` | |
| `setLayerAnimated(id, a)` | `animation.setLayerAnimated(id, a)` | |
| `isLayerAnimated(id)` | `animation.isLayerAnimated(id)` | |
| `addCelAtCurrentFrame(id)` | `animation.addCelAtCurrentFrame(id)` | |
| `addCelAtFrame(id, f)` | `animation.addCelAtFrame(id, f)` | |
| `deleteCel(lid, cid)` | `animation.deleteCel(lid, cid)` | |
| `setLoopMode(m)` | `animation.setLoopMode(m)` | |
| `setOnionSkin(c)` | `animation.setOnionSkin(c)` | |
| `getOnionSkin()` | `animation.getOnionSkin()` | |
| `getTimelineState()` | `animation.getTimelineState()` | |
| `onAnimationEvent(cb)` | `animation.onEvent(cb)` | Shortened |
| `duplicateCel(lid, cid, f)` | `animation.duplicateCel(lid, cid, f)` | |
| `moveCel(lid, cid, f)` | `animation.moveCel(lid, cid, f)` | |
| `swapCels(lid, a, b)` | `animation.swapCels(lid, a, b)` | |
| `setCelDuration(lid, cid, d)` | `animation.setCelDuration(lid, cid, d)` | |
| `setCelType(lid, cid, t)` | `animation.setCelType(lid, cid, t)` | |
| `getCels(lid)` | `animation.getCels(lid)` | |

---

### `shapeManager.scene3d` — 3D Scene Operations

| Legacy Call | New Call | Notes |
|---|---|---|
| `getCamera3D()` | `scene3d.getCamera()` | Shortened |
| `createCamera3D(config)` | `scene3d.createCamera(config)` | |
| `enableOrbitControls(config)` | `scene3d.enableOrbitControls(config)` | |
| `disableOrbitControls()` | `scene3d.disableOrbitControls()` | |
| `getOrbitController()` | `scene3d.getOrbitController()` | |
| `createBox3D(x,y,z,w,h,d,mat)` | `scene3d.createBox(x,y,z,w,h,d,mat)` | Dropped "3D" suffix |
| `createSphere3D(x,y,z,r,s,mat)` | `scene3d.createSphere(x,y,z,r,s,mat)` | |
| `createPlane3D(x,y,z,w,h,mat)` | `scene3d.createPlane(x,y,z,w,h,mat)` | |
| `createCylinder3D(x,y,z,r,h,s,mat)` | `scene3d.createCylinder(x,y,z,r,h,s,mat)` | |
| `createTorus3D(x,y,z,r,tr,mat)` | `scene3d.createTorus(x,y,z,r,tr,mat)` | |
| `createCustomMesh3D(x,y,z,geo,mat)` | `scene3d.createCustomMesh(x,y,z,geo,mat)` | |
| `getMesh3D(id)` | `scene3d.getMesh(id)` | |
| `setPosition3D(id,x,y,z)` | `scene3d.setPosition(id,x,y,z)` | |
| `setRotation3D(id,rx,ry,rz)` | `scene3d.setRotation(id,rx,ry,rz)` | |
| `setScale3D(id,sx,sy,sz)` | `scene3d.setScale(id,sx,sy,sz)` | |
| `setMeshMaterial(id, mat)` | `scene3d.setMaterial(id, mat)` | |
| `setMeshDiffuseColor(id,r,g,b,a)` | `scene3d.setDiffuseColor(id,r,g,b,a)` | |
| `setMeshOpacity(id, o)` | `scene3d.setOpacity(id, o)` | |
| `setMeshPrimitive(id, p, c)` | `scene3d.setPrimitive(id, p, c)` | |
| `setMeshGeometry(id, geo)` | `scene3d.setGeometry(id, geo)` | |
| `setPS1Config(c)` | `scene3d.setPS1Config(c)` | |
| `getPS1Config()` | `scene3d.getPS1Config()` | |
| `setDirectionalLight3D(...)` | `scene3d.setDirectionalLight(...)` | |
| `setAmbientLight3D(...)` | `scene3d.setAmbientLight(...)` | |
| `ShapeManager.PS1Defaults` | `Scene3DManager.PS1Defaults` | Static |

---

### `shapeManager.drawing` — Vector Drawing Tools

| Legacy Call | New Call | Notes |
|---|---|---|
| `enableScribbleDrawing()` | `drawing.enableScribbleDrawing()` | Same name |
| `disableScribbleDrawing()` | `drawing.disableScribbleDrawing()` | |
| `enableSectionDrawing()` | `drawing.enableSectionDrawing()` | |
| `disableSectionDrawing()` | `drawing.disableSectionDrawing()` | |
| `enableHighlightDrawing()` | `drawing.enableHighlightDrawing()` | |
| `disableHighlightDrawing()` | `drawing.disableHighlightDrawing()` | |
| `enableTextDrawing()` | `drawing.enableTextDrawing()` | |
| `disableTextDrawing()` | `drawing.disableTextDrawing()` | |
| `isTextDrawingInProgress()` | `drawing.isTextDrawingInProgress()` | |
| `enableLineDrawing()` | `drawing.enableLineDrawing()` | |
| `disableLineDrawing()` | `drawing.disableLineDrawing()` | |
| `enableEraserTool()` | `drawing.enableEraserTool()` | |
| `disableEraserTool()` | `drawing.disableEraserTool()` | |
| `enablePatternDrawing()` | `drawing.enablePatternDrawing()` | |
| `disablePatternDrawing()` | `drawing.disablePatternDrawing()` | |
| `enableStampDrawing()` | `drawing.enableStampDrawing()` | |
| `disableStampDrawing()` | `drawing.disableStampDrawing()` | |
| `enablePanningTool()` | `drawing.enablePanningTool()` | |
| `disablePanningTool()` | `drawing.disablePanningTool()` | |
| `enablePolygonDrawing()` | `drawing.enablePolygonDrawing()` | |
| `disablePolygonDrawing()` | `drawing.disablePolygonDrawing()` | |
| `isPolygonDrawing` | `drawing.isPolygonDrawing` | Getter |
| `isPolygonDrawingInProgress` | `drawing.isPolygonDrawingInProgress` | Getter |
| `setPolygonDrawingColors(f,s,w)` | `drawing.setPolygonDrawingColors(f,s,w)` | |
| `setStrokeColor(c)` | `drawing.setStrokeColor(c)` | |
| `setHighlightColor(c)` | `drawing.setHighlightColor(c)` | |
| `setShapeColor(c)` | `drawing.setShapeColor(c)` | |
| `setTextColor(c)` | `drawing.setTextColor(c)` | |
| `setStrokeWidth(w)` | `drawing.setStrokeWidth(w)` | |
| `setStampTexture(key)` | `drawing.setStampTexture(key)` | |
| `setStampSize(s)` | `drawing.setStampSize(s)` | |
| `setStampColor(c)` | `drawing.setStampColor(c)` | |
| `setPattern(p)` | `drawing.setPattern(p)` | |
| `createRectangle(...)` | `drawing.createRectangle(...)` | |
| `createCircle(...)` | `drawing.createCircle(...)` | |
| `createTriangle(...)` | `drawing.createTriangle(...)` | |
| `createLine(...)` | `drawing.createLine(...)` | |
| `createArrow(...)` | `drawing.createArrow(...)` | |
| `setArrowheads(...)` | `drawing.setArrowheads(...)` | |
| `ShapeManager.ArrowheadStyles` | `DrawingToolManager.ArrowheadStyles` | Static |
| `createStickyNote(...)` | `drawing.createStickyNote(...)` | |
| `createScribble(...)` | `drawing.createScribble(...)` | |
| `createHighlight(...)` | `drawing.createHighlight(...)` | |
| `createRegularPolygon(...)` | `drawing.createRegularPolygon(...)` | |
| `createPolygonFromPoints(...)` | `drawing.createPolygonFromPoints(...)` | |
| `createPresetPolygon(...)` | `drawing.createPresetPolygon(...)` | |
| `ShapeManager.PolygonPresets` | `DrawingToolManager.PolygonPresets` | Static |
| `setPreviewShape(type, event)` | `drawing.setPreviewShape(type, event)` | |
| `updatePreviewShapePosition(e)` | `drawing.updatePreviewShapePosition(e)` | |
| `confirmPreviewShape()` | `drawing.confirmPreviewShape()` | |
| `importImageToCurrentLayer(src)` | `drawing.importImageToCurrentLayer(src)` | |
| `importImageToLayer(id, src)` | `drawing.importImageToLayer(id, src)` | |
| `importImageAsNewLayer(src, n)` | `drawing.importImageAsNewLayer(src, n)` | |
| `importRasterLayersFromDataURLs(l)` | `drawing.importRasterLayersFromDataURLs(l)` | |
| `defaultPolygonSides` | `drawing.defaultPolygonSides` | Public property |

---

### `shapeManager.persist` — Document Persistence

| Legacy Call | New Call | Notes |
|---|---|---|
| `isAutoSaveAvailable()` | `persist.isAutoSaveAvailable()` | |
| `enableAutoSave(id, name, cfg)` | `persist.enableAutoSave(id, name, cfg)` | |
| `disableAutoSave()` | `persist.disableAutoSave()` | |
| `setAutoSaveConfig(c)` | `persist.setAutoSaveConfig(c)` | |
| `getAutoSaveConfig()` | `persist.getAutoSaveConfig()` | |
| `onSaveEvent(start, end)` | `persist.onSaveEvent(start, end)` | |
| `saveDocument()` | `persist.saveDocument()` | |
| `loadDocument(id)` | `persist.loadDocument(id)` | |
| `listSavedDocuments()` | `persist.listSavedDocuments()` | |
| `deleteSavedDocument(id)` | `persist.deleteSavedDocument(id)` | |
| `setDocumentName(n)` | `persist.setDocumentName(n)` | |
| `getDocumentName()` | `persist.getDocumentName()` | |
| `getDocumentId()` | `persist.getDocumentId()` | |
| `notifyStrokeEnd()` | `persist.notifyStrokeEnd()` | |

---

## Recommended Migration Order

Migrate by **impact & frequency** — largest call-sites first:

1. **Raster layer panel** — `getRasterLayers`, `addRasterLayer`, `deleteRasterLayer`, `selectRasterLayer`, `setRasterLayerVisibility`, `setRasterLayerBlendMode`, `setRasterLayerOpacity`, `reorderRasterLayers` → `raster.*`
2. **Brush toolbar** — `setRasterBrushSize`, `setRasterBrushColor`, `enableRasterDrawing`, `disableRasterDrawing`, `enableRasterEraserTool`, `disableRasterEraserTool` → `raster.*`
3. **Tool switcher** — All `enable*`/`disable*` calls → `drawing.*` or `raster.*`
4. **Timeline panel** — All animation methods → `animation.*`
5. **Text toolbar** — SDF text + LiveText methods → `text.*`
6. **Dither controls** — All `setDither*` → `raster.*`
7. **Persistence** — Auto-save/load → `persist.*`
8. **3D viewport** — Camera, mesh, PS1 → `scene3d.*`

## Quick-Find Regex for Frogmarks Codebase

Use these to find all call sites that need migration:

```bash
# Raster — matches ~120 methods
grep -rn 'shapeManager\.\(enableRaster\|disableRaster\|raster\|setRaster\|getRaster\|floodFill\|worldToTexel\|fillSelection\|setBrush\|getBrush\|setCanvas\|getCanvas\|setPaper\|getPaper\|setDither\|getDither\|swapDither\|setLayer\(Dither\|FrameLink\)\|getLayer\(Dither\|FrameLink\)\|getDefault\|setActive\(Stab\|Brush\)\|getActive\(Stab\|Brush\)\|getAvailable\|importBrush\|exportBrush\|export\All\|register\|delete\(Brush\)\|update\(Brush\)\|setMagic\|rasterSelect\|rasterDeselect\|rasterInvert\|rasterDelete\|rasterCut\|rasterCopy\|rasterPaste\|rasterBegin\|rasterUpdate\|rasterCommit\|rasterCancel\|rasterFlip\|rasterRotate\|rasterScale\|rasterUndo\|rasterRedo\|rasterPush\|pushSnapshot\)' src/

# Drawing tools
grep -rn 'shapeManager\.\(enableScribble\|disableScribble\|enableSection\|disableSection\|enableHighlight\|disableHighlight\|enableText\|disableText\|enableLine\|disableLine\|enableEraser\|disableEraser\|enablePattern\|disablePattern\|enableStamp\|disableStamp\|enablePanning\|disablePanning\|enablePolygon\|disablePolygon\|setStroke\|setHighlightColor\|setShapeColor\|setTextColor\|setStampTexture\|setStampSize\|setStampColor\|setPattern\|createRect\|createCircle\|createTriangle\|createLine\|createArrow\|createStickyNote\|createScribble\|createHighlight\|createRegular\|createPolygon\|createPreset\|setPreview\|updatePreview\|confirmPreview\|importImage\)' src/

# Text
grep -rn 'shapeManager\.\(enableSDF\|disableSDF\|isSDF\|setSDF\|updateSDF\|isInputActive\|getEditingLive\|captureText\|isHtmlInCanvas\|getHtmlInCanvas\|setupHtml\|requestHtml\|captureElement\|applyText\|validate\|setCustom\|removeCustom\|createEffected\|stampEffected\|createLive\|setLiveText\|beginLive\|endLive\|flattenLive\|getLiveText\)' src/

# Animation
grep -rn 'shapeManager\.\(setAnimation\|isAnimation\|setCurrent\|getCurrent\|getFrame\|setFrame\|setPlayRange\|getPlayRange\|getFps\|setFps\|addFrames\|insertFrame\|deleteFrame\|nextFrame\|prevFrame\|play\b\|pause\b\|stop\b\|toggle\|setLayerAnimated\|isLayerAnimated\|addCel\|deleteCel\|setLoopMode\|setOnionSkin\|getOnionSkin\|getTimeline\|onAnimation\|duplicateCel\|moveCel\|swapCel\|setCelDuration\|setCelType\|getCels\)' src/

# Persistence
grep -rn 'shapeManager\.\(isAutoSave\|enableAutoSave\|disableAutoSave\|setAutoSave\|getAutoSave\|onSaveEvent\|saveDocument\|loadDocument\|listSaved\|deleteSaved\|setDocumentName\|getDocumentName\|getDocumentId\|notifyStrokeEnd\)' src/

# 3D
grep -rn 'shapeManager\.\(getCamera3D\|createCamera3D\|enableOrbit\|disableOrbit\|getOrbit\|createBox3D\|createSphere3D\|createPlane3D\|createCylinder3D\|createTorus3D\|createCustomMesh\|getMesh3D\|setPosition3D\|setRotation3D\|setScale3D\|setMeshMaterial\|setMeshDiffuse\|setMeshOpacity\|setMeshPrimitive\|setMeshGeometry\|setPS1\|getPS1\|setDirectional\|setAmbient\)' src/
```

---

## Import Paths for Direct Delegate Use

If a Frogmarks module needs to type-hint or import a delegate directly:

```ts
// Barrel import — all managers
import { RasterManager, TextManager, AnimationManager, Scene3DManager, DrawingToolManager, PersistenceManager } from 'salsa/src/services/managers';

// Individual imports
import { RasterManager } from 'salsa/src/services/managers/raster-manager';
import { TextManager } from 'salsa/src/services/managers/text-manager';
import { AnimationManager } from 'salsa/src/services/managers/animation-manager';
import { Scene3DManager } from 'salsa/src/services/managers/scene3d-manager';
import { DrawingToolManager } from 'salsa/src/services/managers/drawing-tool-manager';
import { PersistenceManager } from 'salsa/src/services/managers/persistence-manager';
```

---

## Methods That Stay on ShapeManager (No Migration Needed)

These methods remain on ShapeManager directly — they're core scene-graph operations or small feature groups that don't warrant their own delegate:

- **Core:** `setBackgroundColor`, `getBackgroundColor`, `setDotColor`, `getDotColor`, `setSelectedNode`, `addSelectedNode`, `clearSelectedNodes`, `deselectNode`, `getLayers`, `addLayer`, `deleteLayer`, `selectLayer`, `getSelectedLayerId`, `setNodeFillColor`, `getNodeFillColor`, `getNodePosition`, `setNodePosition`, `setNodeVisibility`, `setNodeLocked`, `setNodeName`, `getNodeById`, `deleteSelectedShapes`, `clear`
- **Connector:** `getConnectorService`, `setSnapThreshold`, `findSnapTarget`, `bindLineStart`, `bindLineEnd`, `unbindLineStart`, `unbindLineEnd`, `updateConnectors`, `getAllConnectionPoints`, `getShapeConnectionPoints`, `setDefaultArrowheads`
- **SpeechBalloon:** `createSpeechBalloon`, `getSpeechBalloon`, `setSpeechBalloonText`, `setSpeechBalloonWritingMode`, `setSpeechBalloonTail`, `setSpeechBalloonTailTarget`, `setSpeechBalloonStyle`, `getSpeechBalloonTailPoints`
- **PanelLayout:** `createPanelLayout`, `createPanelLayoutForIllustration`, `getPanelLayout`, `applyPanelTemplate`, `splitPanelHorizontal`, `splitPanelVertical`, `mergePanels`, `removePanel`, `setPanelReadingOrder`, `setPanelGutter`, `setPanelBleed`, `getPanelBleedGuide`, `getPanelGutterGuides`, `getPanelList`
- **Serialization:** `getSceneGraphJSON`, `getSceneGraphJSONWithRasterData`, `setSceneGraphJSON`, `updateSceneGraph`, `waitForFrameSettled`, `captureThumbnailBlob`, `exportRasterLayerToBlob`, `exportAllRasterLayersAsBlobs`, `setIllustrationMode`, `getIllustrationMode`, `setIllustrationBounds`, `setBackgroundPatternFixed`
