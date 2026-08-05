// BollardManager — minimal-manager template (see bike-rack-manager.ts). Everything but these five members
// comes from ProceduralObjectManager + the generic typeId dispatcher.

import { buildBollard, resolveBollardParams } from '../../world/bollard';
import type { BollardParams, BollardMeta } from '../../world/bollard';
import { ProceduralObjectManager } from './procedural-object-manager';

export class BollardManager extends ProceduralObjectManager<BollardParams, BollardMeta> {
    protected readonly kind = 'bollard';
    protected readonly meshLabel = 'Bollard Mesh';
    protected build(p: BollardParams): { layers: ReturnType<typeof buildBollard>['layers']; meta: BollardMeta } { return buildBollard(p); }
    protected resolveParams(partial: unknown): BollardParams { return resolveBollardParams(partial as Partial<BollardParams>); }
    protected makeName(): string { return `Bollard ${++this._counter}`; }
}
