export class StampRegistry {
    private stamps = new Map<string, any>();
    
    constructor() {}
    
    register(stamp: any): void {
        this.stamps.set(stamp.id, stamp);
    }
    
    unregister(stampId: string): void {
        this.stamps.delete(stampId);
    }
    
    get(stampId: string): any {
        return this.stamps.get(stampId);
    }
    
    clear(): void {
        this.stamps.clear();
    }
    
    getAll(): any[] {
        return Array.from(this.stamps.values());
    }
}