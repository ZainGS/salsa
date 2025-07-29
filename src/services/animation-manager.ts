// import { SceneGraph } from '../path/to/scene-graph'; // Adjust import as needed
// import { InteractionService } from './interaction-service'; // Adjust import as needed
// import ShapeManager from './shape-manager';

// // src/services/animation-manager.ts


// export interface Frame {
//     id: number;
//     order: number;
//     data: any; // Replace with your actual frame data structure
//     sceneGraph: SceneGraph;
// }

// export class AnimationManager {
//     private frames: Frame[] = [];
//     private currentFrameIndex: number = 0;
//     private interactionService: InteractionService;
//     private maxFrameIndex: number = 0;

//     constructor(
//         interactionService: InteractionService,
//         shapeManager: ShapeManager = ShapeManager.getInstance()
//     ) {
//         this.interactionService = interactionService;
//     }

//     createNewFrame(data: any, sceneGraph: SceneGraph): Frame {
//         const newFrame: Frame = {
//             id: this.maxFrameIndex+1,
//             order: this.frames.length,
//             data,
//             sceneGraph,
//         };
//         this.frames.push(newFrame);
//         this.currentFrameIndex = this.frames.length - 1;
//         return newFrame;
//     }

//     setSceneGraphInInteractionService(sceneGraph: SceneGraph): void {
//         this.shapeManager.setSceneGraph(sceneGraph);
//     }

//     // ... rest of your methods remain unchanged ...
// }
