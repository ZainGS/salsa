// ABoardManager — minimal-manager template (see bollard-manager.ts).
import { buildABoard, resolveABoardParams } from '../../world/a-board';
import type { ABoardParams, ABoardMeta } from '../../world/a-board';
import { ProceduralObjectManager } from './procedural-object-manager';

export class ABoardManager extends ProceduralObjectManager<ABoardParams, ABoardMeta> {
    protected readonly kind = 'a-board';
    protected readonly meshLabel = 'A-Board Mesh';
    protected build(p: ABoardParams): { layers: ReturnType<typeof buildABoard>['layers']; meta: ABoardMeta } { return buildABoard(p); }
    protected resolveParams(partial: unknown): ABoardParams { return resolveABoardParams(partial as Partial<ABoardParams>); }
    protected makeName(): string { return `A-Board ${++this._counter}`; }
}
