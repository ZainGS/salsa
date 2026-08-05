// VentManager — minimal-manager template (see bollard-manager.ts).
import { buildVent, resolveVentParams } from '../../world/vent';
import type { VentParams, VentMeta } from '../../world/vent';
import { ProceduralObjectManager } from './procedural-object-manager';

export class VentManager extends ProceduralObjectManager<VentParams, VentMeta> {
    protected readonly kind = 'vent';
    protected readonly meshLabel = 'Vent Mesh';
    protected build(p: VentParams): { layers: ReturnType<typeof buildVent>['layers']; meta: VentMeta } { return buildVent(p); }
    protected resolveParams(partial: unknown): VentParams { return resolveVentParams(partial as Partial<VentParams>); }
    protected makeName(): string { return `Vent ${++this._counter}`; }
}
