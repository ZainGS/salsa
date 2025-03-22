import { mat4, vec3 } from 'gl-matrix';
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { rgbaToCssString } from '../../utils/color';
import { Shape } from './base/shape';

export class Text extends Shape {
    private text: string;
    private font: string;
    private textAlign: CanvasTextAlign;
    private textBaseline: CanvasTextBaseline;
    public textureView: GPUTextureView | null = null;
    private texture: GPUTexture | null = null;
    private caretIndex: number = 0; // Tracks where the cursor is
    caretVisible: boolean = true;
    isTyping: boolean = false;

    constructor(
        renderStrategy: RenderStrategy, 
        text: string,
        font: string = '16px Arial',
        color: RGBA = { r: 0, g: 0, b: 0, a: 1 },
        textAlign: CanvasTextAlign = 'left',
        textBaseline: CanvasTextBaseline = 'alphabetic',
        strokeWidth: number = 1,
        interactionService: InteractionService
    ) {
        super(renderStrategy, color, { r: 0, g: 0, b: 0, a: 0 }, strokeWidth, interactionService);
        this.text = text;
        this.font = font;
        this.textAlign = textAlign;
        this.textBaseline = textBaseline;
        
        this.calculateBoundingBox();
        this.updateTexture();

        setInterval(() => {
            if(this.isTyping) {
                this.caretVisible = !this.caretVisible;
            } else {
                this.caretVisible = false;
            }
            
        }, 500);
    }

    public setText(newText: string, moveCursor: boolean = true) {
        if (this.text !== newText) {
            this.text = newText;
            if (moveCursor) {
                this.caretIndex = this.text.length; // Move to end
            }
            this.calculateBoundingBox();
            this.updateTexture();
        }
    }

    public updateTexture() {
        if (!this.text || this.text.trim() === "") {
            console.error("Empty text, skipping texture creation.");
            return;
        }
    
        const device = (this.renderStrategy as any).device;
        if (!device) {
            console.error("WebGPU device is not initialized.");
            return;
        }
    
        const scaleFactor = 16; // Higher value = better text quality
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
    
        ctx.font = `${scaleFactor * 16}px Arial`;  // Scale font for high DPI
        const textMetrics = ctx.measureText(this.text);
        const ascent = textMetrics.fontBoundingBoxAscent || textMetrics.actualBoundingBoxAscent;
        const descent = textMetrics.fontBoundingBoxDescent || textMetrics.actualBoundingBoxDescent;
        const textHeight = Math.ceil(ascent + descent);
        const textWidth = Math.ceil(textMetrics.width);
    
        canvas.width = textWidth;
        canvas.height = textHeight;
    
        this.width = textWidth / scaleFactor;  // Scale width down for rendering
        this.height = textHeight / scaleFactor; // Scale height down for rendering
    
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = "destination-over"; 
        ctx.fillStyle = "rgba(255, 255, 255, 0)"; // Fully transparent
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.font = `${scaleFactor * 16}px Arial`; 
        ctx.textAlign = this.textAlign;
        ctx.textBaseline = "alphabetic";
        // this._fillColor = { r: .2, g: 0, b: 1, a: 1 }; // red
        ctx.fillStyle = rgbaToCssString(this._fillColor);
        ctx.fillText(this.text, 0, ascent);

        if (!canvas.width || !canvas.height) {
            console.error("Canvas width/height is 0, skipping texture creation.");
            return;
        }
    
        this.createTextTexture(canvas, scaleFactor);
    }

    private createTextTexture(canvas: HTMLCanvasElement, scaleFactor: number) {
        const device = (this.renderStrategy as any).device;
        if (!device) {
            console.error("WebGPU device is not initialized.");
            return;
        }
    
        if (this.texture) {
            this.texture.destroy();
        }
    
        const imageData = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        const bytesPerPixel = 4; // RGBA8Unorm = 4 bytes per pixel
        const unalignedBytesPerRow = canvas.width * bytesPerPixel;
        const alignedBytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256; // Align to 256
    
        this.texture = device.createTexture({
            size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
    
        const paddedData = new Uint8Array(alignedBytesPerRow * canvas.height);
        for (let row = 0; row < canvas.height; row++) {
            const srcStart = row * unalignedBytesPerRow;
            const destStart = row * alignedBytesPerRow;
            paddedData.set(imageData.subarray(srcStart, srcStart + unalignedBytesPerRow), destStart);
        }
    
        device.queue.writeTexture(
            { texture: this.texture },
            paddedData,
            { bytesPerRow: alignedBytesPerRow, rowsPerImage: canvas.height },
            { width: canvas.width, height: canvas.height }
        );
    
        this.textureView = this.texture!.createView();
    }

    calculateBoundingBox() {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) return;

        context.font = `${16}px Arial`;
        const textMetrics = context.measureText(this.text);
    
        const ascent = textMetrics.fontBoundingBoxAscent || textMetrics.actualBoundingBoxAscent;
        const descent = textMetrics.fontBoundingBoxDescent || textMetrics.actualBoundingBoxDescent;
        const textHeight = ascent + descent;
        const textWidth = textMetrics.width;
    
        // The bounding box should match the rendering logic
        this.boundingBox.x = 0;  // Always start at (0,0) in local space
        this.boundingBox.y = 0;
        this.boundingBox.width = textWidth;
        this.boundingBox.height = textHeight;
    }
    
    getCaretPosition(): number {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return 0;
    
        const scaleFactor = 1;
        ctx.font = `${scaleFactor * 16}px Arial`;
    
        const textBeforeCaret = this.text.substring(0, this.caretIndex);
        const textMetrics = ctx.measureText(textBeforeCaret);
    
        return textMetrics.width / 64; // Scale down like text rendering
    }

    getScaleFactors(): [number, number] {
        return [1, 1];
    }

    containsPoint(x: number, y: number): boolean {
        const inverseMatrix = mat4.create();
        if (!mat4.invert(inverseMatrix, this.localMatrix)) {
            console.error("Matrix inversion failed");
            return false;
        }
    
        // Transform mouse (x, y) to local space
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseMatrix);
    
        const scale = 1 / 64;
        const boundingBox = this.boundingBox;
    
        // Match render logic
        return (
            point[0] >= boundingBox.x &&
            point[0] <= boundingBox.x + (boundingBox.width*scale) &&
            point[1] >= boundingBox.y &&
            point[1] <= boundingBox.y + (boundingBox.height*scale)
        );
    }
    
    getType(): string {
        return "Text";
    }
       
}
