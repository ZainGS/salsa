// src/renderer/renderer.ts
export interface Renderer {
    initialize(): Promise<void>;
    render(): void;
    clear(): void;
    resize(width: number, height: number): void;
}