import React, { useRef, useEffect, useState } from 'react';

// TypeScript declaration for the pdf.js library loaded from CDN.
declare const pdfjsLib: any;

interface PdfPageProps {
  pdfDoc: any; // PDFDocumentProxy
  pageNumber: number;
  highlightedWordIndex: number | null;
  onWordsParsed: (pageNumber: number, wordCount: number) => void;
}

interface WordItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export const PdfPage = React.forwardRef<HTMLDivElement, PdfPageProps>(
  ({ pdfDoc, pageNumber, highlightedWordIndex, onWordsParsed }, ref) => {
    const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
    const highlightCanvasRef = useRef<HTMLCanvasElement>(null);
    const [status, setStatus] = useState<'loading' | 'rendered' | 'error'>('loading');
    const [words, setWords] = useState<WordItem[]>([]);
    const [viewport, setViewport] = useState<any>(null);
    const scale = 2.0;

    useEffect(() => {
      let isCancelled = false;
      const renderPage = async () => {
        try {
          const page = await pdfDoc.getPage(pageNumber);
          if (isCancelled) return;

          const canvas = pdfCanvasRef.current;
          if (!canvas) return;

          const context = canvas.getContext('2d');
          if (!context) return;

          const pageViewport = page.getViewport({ scale });
          setViewport(pageViewport);

          canvas.height = pageViewport.height;
          canvas.width = pageViewport.width;

          await page.render({ canvasContext: context, viewport: pageViewport }).promise;

          const textContent = await page.getTextContent();
          if (isCancelled) return;

          const parsedWords: WordItem[] = [];
          for (const item of textContent.items) {
            if (!item.str.trim()) continue;

            const parts = item.str.split(/(\s+)/);
            let currentXOffset = 0;

            for (const part of parts) {
              const partWidth = (part.length / item.str.length) * item.width;
              if (part.trim()) {
                const wordTransform = [...item.transform];
                wordTransform[4] += currentXOffset;
                parsedWords.push({
                  str: part,
                  width: partWidth,
                  transform: wordTransform,
                  height: Math.abs(item.transform[3]),
                });
              }
              currentXOffset += partWidth;
            }
          }

          if (!isCancelled) {
            setWords(parsedWords);
            onWordsParsed(pageNumber, parsedWords.length);
            setStatus('rendered');
          }
        } catch (error) {

          if (!isCancelled) setStatus('error');
        }
      };

      if (pdfDoc && pdfCanvasRef.current) {
        renderPage();
      }

      return () => {
        isCancelled = true;
      };
    }, [pdfDoc, pageNumber, onWordsParsed]);

    useEffect(() => {
      if (!highlightCanvasRef.current || !viewport || words.length === 0) return;

      const canvas = highlightCanvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      context.clearRect(0, 0, canvas.width, canvas.height);

      if (highlightedWordIndex !== null && words[highlightedWordIndex]) {
        const wordItem = words[highlightedWordIndex];

        context.fillStyle = 'rgba(255, 255, 0, 0.4)';
        context.globalCompositeOperation = 'multiply';

        const tx = pdfjsLib.Util.transform(viewport.transform, wordItem.transform);
        const x = tx[4];
        const y = tx[5];

        const width = wordItem.width * scale;
        const height = wordItem.height * scale * 1.2;

        context.fillRect(x, y - height * 0.85, width, height);
      }

    }, [words, viewport, highlightedWordIndex]);

    return (
      <div ref={ref} className="bg-white p-4 rounded-lg shadow-lg flex flex-col items-center">
        <div className="relative w-full">
          {status === 'loading' && (
            <div className="absolute inset-0 bg-gray-200 bg-opacity-75 flex items-center justify-center z-10 rounded-md">
              <p className="text-gray-600">Loading page {pageNumber}...</p>
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-0 bg-red-100 flex items-center justify-center z-10 rounded-md">
              <p className="text-red-600">Could not load page {pageNumber}</p>
            </div>
          )}
          <canvas ref={pdfCanvasRef} className="w-full h-auto" />
          <canvas ref={highlightCanvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />
        </div>
        <div className="text-center text-sm text-gray-500 pt-2">Page {pageNumber}</div>
      </div>
    );
  }
);
