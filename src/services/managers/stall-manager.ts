// StallManager — minimal-manager template (see bollard-manager.ts).
import { buildStall, resolveStallParams } from '../../world/stall';
import type { StallParams, StallMeta } from '../../world/stall';
import { ProceduralObjectManager } from './procedural-object-manager';

export class StallManager extends ProceduralObjectManager<StallParams, StallMeta> {
    protected readonly kind = 'stall';
    protected readonly meshLabel = 'Stall Mesh';
    protected build(p: StallParams): { layers: ReturnType<typeof buildStall>['layers']; meta: StallMeta } { return buildStall(p); }
    protected resolveParams(partial: unknown): StallParams { return resolveStallParams(partial as Partial<StallParams>); }
    protected makeName(): string { return `Stall ${++this._counter}`; }
}
