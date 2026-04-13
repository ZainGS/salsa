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

    zoomIn(illustrationMode?: boolean, illustrationBounds?: { width: number; height: number }) {
        this.interactionService.adjustZoom(0.25, 0, 0, illustrationMode, illustrationBounds);
    }

    zoomOut(illustrationMode?: boolean, illustrationBounds?: { width: number; height: number }) {
        this.interactionService.adjustZoom(-0.25, 0, 0, illustrationMode, illustrationBounds);
    }

    /** Get the current zoom factor. */
    getZoomFactor(): number {
        return this.interactionService.getZoomFactor();
    }

    public resetWorldState(): void {
        if (this.interactionService) {
            this.interactionService.reset();
        }
    }
    
}

// Export only the singleton getter function
export default WorldManager;