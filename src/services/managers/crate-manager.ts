// CrateManager — minimal-manager template (see bollard-manager.ts). Everything but these five members
// comes from ProceduralObjectManager + the generic typeId dispatcher.

import { buildCrate, resolveCrateParams } from '../../world/crate';
import type { CrateParams, CrateMeta } from '../../world/crate';
import { ProceduralObjectManager } from './procedural-object-manager';

export class CrateManager extends ProceduralObjectManager<CrateParams, CrateMeta> {
    protected readonly kind = 'crate';
    protected readonly meshLabel = 'Crate Mesh';
    protected build(p: CrateParams): { layers: ReturnType<typeof buildCrate>['layers']; meta: CrateMeta } { return buildCrate(p); }
    protected resolveParams(partial: unknown): CrateParams { return resolveCrateParams(partial as Partial<CrateParams>); }
    protected makeName(): string { return `Crates ${++this._counter}`; }
}
