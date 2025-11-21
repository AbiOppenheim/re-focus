import { PDFDocument } from 'pdf-lib';
import { WordItem } from '../types';

/**
 * Save PDF with highlight annotations
 */
export async function savePdfWithHighlights(
    pdfBytes: Uint8Array,
    annotatedIndicesMap: Record<number, number[]>,
    pageWords: Record<number, WordItem[]>
): Promise<void> {
    try {
        const pdfDocLib = await PDFDocument.load(pdfBytes);
        const pages = pdfDocLib.getPages();

        // Iterate over all pages with annotations
        for (const [pageNumStr, indices] of Object.entries(annotatedIndicesMap)) {
            const pageNum = parseInt(pageNumStr, 10); // 1-based
            if (isNaN(pageNum) || pageNum < 1 || pageNum > pages.length) continue;

            const page = pages[pageNum - 1]; // 0-based
            const wordsOnPage = pageWords[pageNum] || [];

            // 1. Collect all highlighted word rects on this page
            const rawRects: { x: number; y: number; width: number; height: number; lineY: number }[] = [];

            for (const idx of indices) {
                const word = wordsOnPage[idx];
                if (!word) continue;

                const x = word.transform[4];
                const y = word.transform[5];
                const width = word.width;
                const height = word.height;

                const pdfBottom = y - (height * 0.35);
                const pdfHeight = height * 1.2;

                rawRects.push({
                    x: x,
                    y: pdfBottom,
                    width: width,
                    height: pdfHeight,
                    lineY: Math.round(y)
                });
            }

            if (rawRects.length === 0) continue;

            // 2. Merge adjacent rects into lines
            rawRects.sort((a, b) => (b.lineY - a.lineY) || (a.x - b.x));

            const mergedRects: typeof rawRects = [];
            const lineTolerance = 5;
            const gapTolerance = 10;

            let current = rawRects[0];
            for (let i = 1; i < rawRects.length; i++) {
                const next = rawRects[i];

                if (Math.abs(next.lineY - current.lineY) <= lineTolerance) {
                    const currentRight = current.x + current.width;
                    if (next.x <= currentRight + gapTolerance) {
                        const newX = Math.min(current.x, next.x);
                        const newRight = Math.max(currentRight, next.x + next.width);
                        const newBottom = Math.min(current.y, next.y);
                        const newTop = Math.max(current.y + current.height, next.y + next.height);

                        current = {
                            x: newX,
                            y: newBottom,
                            width: newRight - newX,
                            height: newTop - newBottom,
                            lineY: current.lineY
                        };
                        continue;
                    }
                }

                mergedRects.push(current);
                current = next;
            }
            mergedRects.push(current);

            // 3. Create Highlight Annotations for each merged rect
            for (const rect of mergedRects) {
                const quadPoints = [
                    rect.x, rect.y,
                    rect.x + rect.width, rect.y,
                    rect.x + rect.width, rect.y + rect.height,
                    rect.x, rect.y + rect.height
                ];

                const highlightAnnot = pdfDocLib.context.obj({
                    Type: 'Annot',
                    Subtype: 'Highlight',
                    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
                    QuadPoints: quadPoints,
                    C: [0.56, 0.93, 0.56], // RGB color (Light Green)
                    F: 4, // Flags: 4 = Print
                });

                const highlightAnnotRef = pdfDocLib.context.register(highlightAnnot);
                page.node.addAnnot(highlightAnnotRef);
            }
        }

        const modifiedPdfBytes = await pdfDocLib.save();
        const blob = new Blob([modifiedPdfBytes as any], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'highlighted_document.pdf';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

    } catch (err) {
        console.error('Error saving PDF:', err);
        alert('Failed to save PDF with highlights.');
    }
}

/**
 * Load PDF file and return bytes
 */
export async function loadPdfFile(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const arrayBuffer = e.target?.result as ArrayBuffer;
            if (arrayBuffer) {
                resolve(new Uint8Array(arrayBuffer));
            } else {
                reject(new Error('Failed to read file'));
            }
        };
        reader.onerror = () => reject(new Error('File reading error'));
        reader.readAsArrayBuffer(file);
    });
}
