// LampPostManager — minimal-manager template (see bollard-manager.ts). Everything but these five members
// comes from ProceduralObjectManager + the generic typeId dispatcher.

import { buildLampPost, resolveLampPostParams } from '../../world/lamp-post';
import type { LampPostParams, LampPostMeta } from '../../world/lamp-post';
import { ProceduralObjectManager } from './procedural-object-manager';

export class LampPostManager extends ProceduralObjectManager<LampPostParams, LampPostMeta> {
    protected readonly kind = 'lamp-post';
    protected readonly meshLabel = 'Lamp Post Mesh';
    protected build(p: LampPostParams): { layers: ReturnType<typeof buildLampPost>['layers']; meta: LampPostMeta } { return buildLampPost(p); }
    protected resolveParams(partial: unknown): LampPostParams { return resolveLampPostParams(partial as Partial<LampPostParams>); }
    protected makeName(): string { return `Lamp Post ${++this._counter}`; }
}
