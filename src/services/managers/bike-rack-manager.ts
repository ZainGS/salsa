// BikeRackManager — lifecycle for a standalone bike rack. Deliberately MINIMAL: the base
// ProceduralObjectManager supplies the whole create/edit/transform/remove/restore/persist/gizmo lifecycle,
// and the generic typeId dispatcher (ShapeManager.createCreator3D / setCreatorParams3D) supplies the host
// API — so a new prop costs only these five members. This is the template for every future simple prop.

import { buildBikeRack, resolveBikeRackParams } from '../../world/bike-rack';
import type { BikeRackParams, BikeRackMeta } from '../../world/bike-rack';
import { ProceduralObjectManager } from './procedural-object-manager';

export class BikeRackManager extends ProceduralObjectManager<BikeRackParams, BikeRackMeta> {
    protected readonly kind = 'bike-rack';
    protected readonly meshLabel = 'Bike Rack Mesh';
    protected build(p: BikeRackParams): { layers: ReturnType<typeof buildBikeRack>['layers']; meta: BikeRackMeta } { return buildBikeRack(p); }
    protected resolveParams(partial: unknown): BikeRackParams { return resolveBikeRackParams(partial as Partial<BikeRackParams>); }
    protected makeName(): string { return `Bike Rack ${++this._counter}`; }
}
