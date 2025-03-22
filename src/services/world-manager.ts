import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Shape } from "../scene-graph/shapes/base/shape";
import { RGBA } from "../types/rgba";
import { LineDrawingService } from "../services/line-drawing-service";
import { InteractionService } from "./interaction-service";

class WorldManager {

    private interactionService: InteractionService;
    private static instance: WorldManager | null = null; // Singleton instance

    private constructor(interactionService: InteractionService) {
        this.interactionService = interactionService;
    }

    // Public method to get the singleton instance
    static getInstance(interactionService?: InteractionService): WorldManager {
        if (!WorldManager.instance) {
            if (!interactionService) {
                throw new Error("Interaction Service must be provided on first call!");
            }

            WorldManager.instance = new WorldManager(interactionService);
        }
        return WorldManager.instance;
    }

    zoomIn() {
        this.interactionService.adjustZoom(0.25, 0, 0);
    }

    zoomOut() {
        this.interactionService.adjustZoom(-0.25, 0, 0);
    }

    public resetWorldState(): void {
        console.log("Resetting WorldManager state and interaction service...");
        if (this.interactionService) {
            this.interactionService.reset(); // Ensure zoom/pan resets
        }
    }
    
}


// Export only the singleton getter function
export default WorldManager;