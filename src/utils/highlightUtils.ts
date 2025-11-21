import { PDF_SCALE, LINE_TOLERANCE_MULTIPLIER, GAP_TOLERANCE_MULTIPLIER } from '../constants';

export interface HighlightRect {
    x: number;
    y: number;
    width: number;
    height: number;
    lineY: number;
}

/**
 * Merge adjacent highlight rectangles on the same line
 */
export function mergeHighlightRects(rawRects: HighlightRect[]): HighlightRect[] {
    if (rawRects.length === 0) return [];

    rawRects.sort((a, b) => (a.lineY - b.lineY) || (a.x - b.x));
    const merged: HighlightRect[] = [];
    const lineTolerance = Math.max(2, LINE_TOLERANCE_MULTIPLIER * PDF_SCALE);

    // Calculate adaptive gap tolerance based on average word width
    const avgWidth = rawRects.reduce((sum, r) => sum + r.width, 0) / rawRects.length;
    const gapTolerance = Math.max(12 * PDF_SCALE, avgWidth * 0.8);

    let current = rawRects[0];
    for (let i = 1; i < rawRects.length; i++) {
        const next = rawRects[i];
        if (Math.abs(next.lineY - current.lineY) <= lineTolerance) {
            const currentRight = current.x + current.width;
            const nextRight = next.x + next.width;
            if (next.x <= currentRight + gapTolerance) {
                const newRight = Math.max(currentRight, nextRight);
                const newTop = Math.min(current.y, next.y);
                const newBottom = Math.max(current.y + current.height, next.y + next.height);
                current = {
                    x: Math.min(current.x, next.x),
                    y: newTop,
                    width: newRight - Math.min(current.x, next.x),
                    height: newBottom - newTop,
                    lineY: Math.round((current.lineY + next.lineY) / 2),
                };
                continue;
            }
        }
        merged.push(current);
        current = next;
    }
    merged.push(current);

    return merged;
}

/**
 * Draw a highlight rectangle on canvas
 */
export function drawHighlight(
    context: CanvasRenderingContext2D,
    rect: HighlightRect,
    color: string,
    opacity: number = 1.0
): void {
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    context.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
}

/**
 * Draw an underline on canvas
 */
export function drawUnderline(
    context: CanvasRenderingContext2D,
    rect: HighlightRect,
    color: string,
    thickness: number = 0.1
): void {
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    context.fillStyle = `rgba(${r}, ${g}, ${b}, 1.0)`;

    const underlineHeight = Math.max(2, rect.height * thickness);
    context.fillRect(rect.x, rect.y + rect.height - underlineHeight, rect.width, underlineHeight);
}

/**
 * Calculate word bounding rectangle
 */
export function calculateWordRect(
    word: { transform: number[]; width: number; height: number },
    viewport: any,
    pdfjsLib: any,
    scale: number = PDF_SCALE
): HighlightRect {
    const tx = pdfjsLib.Util.transform(viewport.transform, word.transform);
    const x = tx[4];
    const y = tx[5];
    const width = word.width * scale;
    const height = word.height * scale * 1.2;
    const top = y - height * 0.85;

    return {
        x,
        y: top,
        width,
        height,
        lineY: Math.round(y),
    };
}
