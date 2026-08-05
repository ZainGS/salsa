// TrashBinManager — minimal-manager template (see bollard-manager.ts). Everything but these five members
// comes from ProceduralObjectManager + the generic typeId dispatcher.

import { buildTrashBin, resolveTrashBinParams } from '../../world/trash-bin';
import type { TrashBinParams, TrashBinMeta } from '../../world/trash-bin';
import { ProceduralObjectManager } from './procedural-object-manager';

export class TrashBinManager extends ProceduralObjectManager<TrashBinParams, TrashBinMeta> {
    protected readonly kind = 'trash-bin';
    protected readonly meshLabel = 'Trash Bin Mesh';
    protected build(p: TrashBinParams): { layers: ReturnType<typeof buildTrashBin>['layers']; meta: TrashBinMeta } { return buildTrashBin(p); }
    protected resolveParams(partial: unknown): TrashBinParams { return resolveTrashBinParams(partial as Partial<TrashBinParams>); }
    protected makeName(): string { return `Trash Bin ${++this._counter}`; }
}
