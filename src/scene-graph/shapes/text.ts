import { mat4, vec3, vec4 } from 'gl-matrix';
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
    device!: GPUDevice;

    constructor(
        text: string,
        font: string = '16px Arial',
        color: RGBA = { r: 0, g: 0, b: 0, a: 1 },
        textAlign: CanvasTextAlign = 'left',
        textBaseline: CanvasTextBaseline = 'alphabetic',
        strokeWidth: number = 1,
        interactionService: InteractionService,
        device: GPUDevice
    ) {
        super(color, { r: 0, g: 0, b: 0, a: 0 }, strokeWidth, interactionService);
        this.device = device;
        this.text = text ?? "";
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
        // if (!this.text || this.text.trim() === "") {
        //     console.error("Empty text, skipping texture creation.");
        //     return;
        // }
        
        const device = this.device;
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
            // console.error("Canvas width/height is 0, skipping texture creation.");
            return;
        }
    
        this.createTextTexture(canvas, scaleFactor);
        this.clearGeometryCache();
    }

    private createTextTexture(canvas: HTMLCanvasElement, scaleFactor: number) {
        const device =  this.device;
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
    
        const safeText = this.text || "";  // Fallback if undefined
        const textBeforeCaret = safeText.substring(0, this.caretIndex);
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

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;
    
        const scale = 1 / 64;
        const w = this.width * scale;
        const h = this.height * scale;
    
        const vertices = new Float32Array([
            0, 0, 0, 0,         // Bottom-left
            w, 0, 1, 0,         // Bottom-right
            0, h, 0, 1,         // Top-left
            w, h, 1, 1          // Top-right
        ]);
    
        this.cachedVertices = vertices;
        return vertices;
    }
    
    public getGeometryIndices(): Uint16Array {
        return new Uint16Array(); // Return an empty array instead of null
    }
    
    /**
     * We are using a triangle-strip topology, but if you want to explicitly cache indices 
     * (useful for consistency, or if you switch to indexed drawing), then triangle list indices would be the below.
     * Note: We're currently using draw(4) (non-indexed), but adding this now future-proofs things.
     * We could use drawIndexed(6) and switch to "triangle-list" for consistency across shapes later.
     */
    // public getGeometryIndices(): Uint16Array {
    //     if (this.cachedIndices) return this.cachedIndices;
    
    //     const indices = new Uint16Array([
    //         0, 1, 2,
    //         2, 1, 3
    //     ]);
    
    //     this.cachedIndices = indices;
    //     return indices;
    // }

    public override getWorldSpaceBoundingBoxPolygon(): [number, number][] {
        const scale = 1 / 64; // Match the scaleFactor used during text rendering
        const corners = [
            vec4.fromValues(this.boundingBox.x * scale, this.boundingBox.y * scale, 0, 1),
            vec4.fromValues((this.boundingBox.x + this.boundingBox.width) * scale, this.boundingBox.y * scale, 0, 1),
            vec4.fromValues((this.boundingBox.x + this.boundingBox.width) * scale, (this.boundingBox.y + this.boundingBox.height) * scale, 0, 1),
            vec4.fromValues(this.boundingBox.x * scale, (this.boundingBox.y + this.boundingBox.height) * scale, 0, 1),
        ];
    
        return corners.map(corner => {
            const result = vec4.create();
            vec4.transformMat4(result, corner, this.localMatrix);
            return [result[0], result[1]];
        });
    }

    override getBoundingBoxVertices(thickness: number): Float32Array {
        const scale = 1 / 64;
        const { width, height } = this.boundingBox;
    
        const scaledWidth = width * scale;
        const scaledHeight = height * scale;
    
        return new Float32Array([
            // Outer rectangle
            0 - thickness,             0 - thickness,
            scaledWidth + thickness,  0 - thickness,
            0 - thickness,             scaledHeight + thickness,
            scaledWidth + thickness,  scaledHeight + thickness,
    
            // Inner rectangle
            0, 0,
            scaledWidth, 0,
            0, scaledHeight,
            scaledWidth, scaledHeight
        ]);
    }

    override toJSON() {
        return {
            ...super.toJSON(),
            text: this.text,
            font: this.font,
            fillColor: this._fillColor?.a === 0 ? { r: 1, g: 1, b: 1, a: 1 } : this._fillColor,
        };
    }
       
}
