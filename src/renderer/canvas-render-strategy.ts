// src/rendering/canvas-render-strategy.ts
// Handles rendering of shapes for the Canvas Render Strategy.

import { RenderStrategy } from './render-strategy';
import { Node } from '../scene-graph/node';
import { Rectangle } from '../scene-graph/rectangle';
import { Circle } from '../scene-graph/circle';
import { Line } from '../scene-graph/line';
import { Polygon } from '../scene-graph/polygon';
import { rgbaToCssString } from '../utils/color';

export class CanvasRenderStrategy implements RenderStrategy {
    render(node: Node, ctxOrEncoder: CanvasRenderingContext2D | GPURenderPassEncoder): void {
        if (ctxOrEncoder instanceof CanvasRenderingContext2D) {
            if (!node.visible) return;

            const ctx = ctxOrEncoder; // Type is now CanvasRenderingContext2D

            ctx.save();

            // Apply transformations
            ctx.translate(node.x, node.y);
            ctx.rotate(node.rotation);
            ctx.scale(node.scaleX, node.scaleY);

            // Check for specific node types and call the appropriate draw logic
            if (node instanceof Rectangle) {
                this.drawRectangle(node, ctx);
            } else if (node instanceof Circle) {
                this.drawCircle(node, ctx);
            } else if (node instanceof Line) {
                this.drawLine(node, ctx);
            } else if (node instanceof Polygon) {
                this.drawPolygon(node, ctx);
            }

            // Render children
            node.children.forEach(child => this.render(child, ctx));

            ctx.restore();
        }
    }

    private drawRectangle(rect: Rectangle, ctx: CanvasRenderingContext2D) {
        if (rect.fillColor.a !== 0) {
            ctx.fillStyle = rgbaToCssString(rect.fillColor);
            ctx.fillRect(0, 0, rect.boundingBox!.width, rect.boundingBox!.height);
        }

        if (rect.strokeWidth > 0) {
            ctx.strokeStyle = rgbaToCssString(rect.strokeColor);
            ctx.lineWidth = rect.strokeWidth;
            ctx.strokeRect(0, 0, rect.boundingBox!.width, rect.boundingBox!.height);
        }
    }

    private drawCircle(circle: Circle, ctx: CanvasRenderingContext2D) {
        if (circle.fillColor.a !== 0) {
            ctx.fillStyle = rgbaToCssString(circle.fillColor);
            ctx.beginPath();
            ctx.arc(circle.boundingBox!.width / 2, circle.boundingBox!.height / 2, circle.boundingBox!.width / 2, 0, Math.PI * 2);
            ctx.fill();
        }

        if (circle.strokeWidth > 0) {
            ctx.strokeStyle = rgbaToCssString(circle.strokeColor);
            ctx.lineWidth = circle.strokeWidth;
            ctx.stroke();
        }
    }

    private drawLine(line: Line, ctx: CanvasRenderingContext2D) {
        ctx.beginPath();
        ctx.moveTo(line.startX, line.startY);
        ctx.lineTo(line.endX, line.endY);
        ctx.strokeStyle = rgbaToCssString(line.strokeColor);
        ctx.lineWidth = line.strokeWidth;
        ctx.stroke();
    }

    private drawPolygon(polygon: Polygon, ctx: CanvasRenderingContext2D) {
        if (polygon.points.length < 2) return;

        ctx.beginPath();
        ctx.moveTo(polygon.points[0].x, polygon.points[0].y);

        for (let i = 1; i < polygon.points.length; i++) {
            ctx.lineTo(polygon.points[i].x, polygon.points[i].y);
        }

        ctx.closePath();

        if (polygon.fillColor.a !== 0) {
            ctx.fillStyle = rgbaToCssString(polygon.fillColor);
            ctx.fill();
        }

        if (polygon.strokeWidth > 0) {
            ctx.strokeStyle = rgbaToCssString(polygon.strokeColor);
            ctx.lineWidth = polygon.strokeWidth;
            ctx.stroke();
        }
    }
}