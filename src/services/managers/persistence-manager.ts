/**
 * PersistenceManager — Delegate for document save/load operations.
 *
 * Handles:
 *  - Auto-save enable/disable/config
 *  - Manual save/load
 *  - Document listing and deletion
 *  - Document state gather/restore
 *
 * Frogmarks can access this via `shapeManager.persistence`.
 */

import type { ManagerContext } from './manager-context';
import { DocumentPersistence, DocumentManifest, DocumentSavePayload, DocumentInfo, AutoSaveConfig, isOPFSAvailable } from '../persistence/document-persistence';

/**
 * PersistenceManager needs callbacks into the main ShapeManager for
 * gatherDocumentState/restoreDocumentState. These are injected via setCallbacks().
 */
export interface PersistenceCallbacks {
    gatherDocumentState(): Promise<DocumentSavePayload>;
    restoreDocumentState(payload: DocumentSavePayload): Promise<void>;
    getSceneGraphJSON(): string;
    exportAllBrushPresets(): string;
    importBrushPresets(json: string): string[];
    getDitherConfig(): any;
    setDitherConfig(config: any): void;
    getRasterLayers(): any[];
}

export class PersistenceManager {
    private ctx: ManagerContext;
    private _persistence?: DocumentPersistence;
    private _currentDocId = 'default';
    private _currentDocName = 'Untitled';
    private _callbacks!: PersistenceCallbacks;

    constructor(ctx: ManagerContext) {
        this.ctx = ctx;
    }

    setCallbacks(cb: PersistenceCallbacks): void { this._callbacks = cb; }

    private ensurePersistence(): DocumentPersistence {
        if (!this._persistence) {
            this._persistence = new DocumentPersistence();
            this._persistence.setStateProvider(() => this._callbacks.gatherDocumentState());
        }
        return this._persistence;
    }

    isAutoSaveAvailable(): boolean { return isOPFSAvailable(); }

    enableAutoSave(docId: string, docName = 'Untitled', config?: Partial<AutoSaveConfig>): void {
        this._currentDocId = docId;
        this._currentDocName = docName;
        this._persistence = new DocumentPersistence(config);
        this._persistence.setStateProvider(() => this._callbacks.gatherDocumentState());
        this._persistence.startAutoSave();
    }

    disableAutoSave(): void { this._persistence?.stopAutoSave(); }
    setAutoSaveConfig(config: Partial<AutoSaveConfig>): void { this._persistence?.setConfig(config); }
    getAutoSaveConfig(): AutoSaveConfig | null { return this._persistence?.getConfig() ?? null; }
    onSaveEvent(onStart: () => void, onComplete: (success: boolean) => void): void { this._persistence?.setSaveCallbacks(onStart, onComplete); }

    async saveDocument(): Promise<boolean> {
        return this.ensurePersistence().saveNow();
    }

    async loadDocument(docId: string): Promise<{
        success: boolean;
        layers: Array<{ id: string; name: string; visible: boolean; locked: boolean; blendMode: any; opacity: number; clipped: boolean; lockTransparency: boolean }>;
    }> {
        const persistence = this.ensurePersistence();
        const payload = await persistence.loadDocument(docId);
        if (!payload) return { success: false, layers: [] };
        try {
            await this._callbacks.restoreDocumentState(payload);
            this._currentDocId = docId;
            this._currentDocName = payload.manifest.name;
            return { success: true, layers: this._callbacks.getRasterLayers() };
        } catch (e) {
            console.error('[PersistenceManager] Failed to restore document:', e);
            return { success: false, layers: [] };
        }
    }

    async listSavedDocuments(): Promise<DocumentInfo[]> {
        return this.ensurePersistence().listDocuments();
    }

    async deleteSavedDocument(docId: string): Promise<boolean> {
        return this._persistence?.deleteDocument(docId) ?? false;
    }

    setDocumentName(name: string): void { this._currentDocName = name; }
    getDocumentName(): string { return this._currentDocName; }
    getDocumentId(): string { return this._currentDocId; }
    notifyStrokeEnd(): void { this._persistence?.notifyStrokeEnd(); }

    // Expose internal state for ShapeManager's façade access
    get currentDocId(): string { return this._currentDocId; }
    set currentDocId(v: string) { this._currentDocId = v; }
    get currentDocName(): string { return this._currentDocName; }
    set currentDocName(v: string) { this._currentDocName = v; }
}
