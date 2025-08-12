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
        if (this.interactionService) {
            this.interactionService.reset();
        }
    }
    
}

// Export only the singleton getter function
export default WorldManager;