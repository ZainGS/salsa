import { SceneGraph } from "../../scene-graph/core/scene-graph";
import ShapeManager from "../shape-manager";

export class AnimationService {
    private frames: SceneGraph[] = [];
    private currentIndex = 0;
    private intervalId: any = null;
  
    constructor(private sharedSceneGraph: SceneGraph, private shapeManager: ShapeManager) {}
  
    start(frameJsons: string[], interval: number) {
      this.frames = this.parseFrames(frameJsons);
      this.currentIndex = 0;
  
      if (this.intervalId) clearInterval(this.intervalId);
  
      this.intervalId = setInterval(() => {
        const frame = this.frames[this.currentIndex];
  
        // Swap children only (don't recreate root)
        this.sharedSceneGraph.root.children = frame.root.children;
  
        // Optional: notify renderer
        // renderer.requestRender();
  
        this.currentIndex = (this.currentIndex + 1) % this.frames.length;
      }, interval);
    }
  
    stop() {
      if (this.intervalId) clearInterval(this.intervalId);
      this.intervalId = null;
    }
  
    private parseFrames(frameJsons: string[]): SceneGraph[] {
      return frameJsons.map((jsonStr) => {
        const json = JSON.parse(jsonStr);
        const sg = new SceneGraph();
        this.shapeManager.updateSceneGraph(sg.root, json.root);
        return sg;
      });
    }
  }