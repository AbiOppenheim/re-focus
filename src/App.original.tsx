import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { PDFDocument, rgb, PDFName, PDFString, PDFArray, PDFDict } from 'pdf-lib';

interface WordItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  sectionIndex: number;
  sentenceIndex: number;
}

const PdfPage = React.forwardRef<HTMLDivElement, {
  pdfDoc: any;
  pageNumber: number;
  highlightedWordIndex: number | null;
  visitedWordInfo?: { section: number | null; indices: number[] };
  annotatedIndices?: number[];
  onWordsParsed: (pageNumber: number, words: WordItem[]) => void;
  pdfjsLib: any;
  onWordDoubleClick?: (pageNumber: number, wordIndex: number) => void;
  onWordClick?: (pageNumber: number, wordIndex: number, isShift: boolean) => void; // NEW
  selectionAnchor?: { page: number; word: number } | null; // NEW
  scrollState: React.MutableRefObject<{ ratio: number; isAutoScrolling: boolean }>;
  highlightMode: 'word' | 'phrase'; // NEW
  isHighlightToolActive: boolean; // NEW
  dragSelection: { start: { page: number; word: number }; end: { page: number; word: number } } | null; // NEW
  onWordMouseDown: (pageNumber: number, wordIndex: number) => void; // NEW
  onWordMouseEnter: (pageNumber: number, wordIndex: number) => void; // NEW
  readingHighlightColor: string; // NEW
  readingHighlightStyle: 'highlight' | 'underline'; // NEW
}>(({ pdfDoc, pageNumber, highlightedWordIndex, visitedWordInfo = { section: null, indices: [] }, annotatedIndices = [], onWordsParsed, pdfjsLib, onWordDoubleClick, onWordClick, selectionAnchor, scrollState, highlightMode, isHighlightToolActive, dragSelection, onWordMouseDown, onWordMouseEnter, readingHighlightColor, readingHighlightStyle }, ref) => {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const highlightCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationLayerRef = useRef<HTMLDivElement>(null);
  const wordLayerRef = useRef<HTMLDivElement>(null); // new: layer for word hit-testing
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [status, setStatus] = useState<'loading' | 'rendered' | 'error'>('loading');
  const [words, setWords] = useState<WordItem[]>([]);
  const [viewport, setViewport] = useState<any>(null);
  const scale = 2.0;

  // internal ref so we can reliably access the page DOM (while still forwarding ref to parent)
  const innerRef = useRef<HTMLDivElement | null>(null);
  const combinedRef = useCallback((node: HTMLDivElement | null) => {
    innerRef.current = node;
    if (typeof ref === 'function') {
      ref(node);
    } else if (ref) {
      (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }
  }, [ref]);

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

        // load annotations and store them (links will be rendered on top as anchors)
        try {
          const annots = await page.getAnnotations({ intent: 'display' });
          if (!isCancelled) {
            // keep only Link annotations (we'll support url/dest if available)
            setAnnotations(annots.filter((a: any) => a.subtype === 'Link'));
          }
        } catch (ae) {
          // non-fatal

        }

        const parsedWords: any[] = [];
        let sectionIndex = 0;
        let sentenceIndex = 0;
        let lastY = null;
        let lastLineHeight = null;
        const lineHeightTolerance = 1.5; // Multiplier for detecting paragraph breaks

        for (const item of textContent.items) {
          if (!item.str.trim()) continue;

          const currentY = item.transform[5];
          const currentHeight = Math.abs(item.transform[3]);

          // Filter out vertical/rotated text (skew components non-zero) or invisible text
          if (Math.abs(item.transform[1]) > 1e-4 || Math.abs(item.transform[2]) > 1e-4 || currentHeight <= 0 || item.width <= 0) {
            continue;
          }

          // Detect new section based on large vertical gap (paragraph break)
          if (lastY !== null && lastLineHeight !== null) {
            const verticalGap = Math.abs(currentY - lastY);
            const expectedLineSpacing = lastLineHeight * lineHeightTolerance;

            // Only increment section if gap is significantly larger than normal line spacing
            if (verticalGap > expectedLineSpacing) {
              sectionIndex++;
            }
          }

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
                height: currentHeight,
                sectionIndex: sectionIndex,
                sentenceIndex: sentenceIndex,
              });
              // if part ends with sentence terminator, increment sentenceIndex
              if (/[.!?]$/.test(part.trim())) {
                sentenceIndex++;
              }
            }
            currentXOffset += partWidth;
          }

          lastY = currentY;
          lastLineHeight = currentHeight;
        }

        if (!isCancelled) {
          setWords(parsedWords);
          // send full parsed words to parent so it can manage sections/navigation
          onWordsParsed(pageNumber, parsedWords);
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

  // Keep annotation layer DOM in sync with annotations and viewport
  useEffect(() => {
    const layer = annotationLayerRef.current;
    const canvas = pdfCanvasRef.current;
    if (!layer) return;
    // clear existing children
    layer.innerHTML = '';
    if (!annotations || !annotations.length || !viewport || !canvas || !pdfDoc) return;

    // compute CSS scaling between canvas internal size and displayed size
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / canvas.width;
    const scaleY = canvasRect.height / canvas.height;

    // async creation so we can resolve internal destinations
    (async () => {
      for (const ann of annotations) {
        // only link annots
        if (ann.subtype !== 'Link') continue;

        // try to get an href (external URL)
        const href = ann.url || (ann.action && ann.action === 'URI' && ann.uri) || null;
        // prepare possible internal destination resolution
        let resolvedInternal: { pageNumber: number; destArray?: any[] } | null = null;
        if (!href && ann.dest) {
          try {
            // resolve named or explicit destination to explicit dest array
            const dest = await pdfDoc.getDestination(ann.dest);
            if (dest) {
              // dest[0] is a reference to the page; getPageIndex returns 0-based index
              const pageIndex = await pdfDoc.getPageIndex(dest[0]);
              resolvedInternal = { pageNumber: pageIndex + 1, destArray: dest };
            }
          } catch (err) {

          }
        }

        try {
          const rect = viewport.convertToViewportRectangle(ann.rect);
          const left = Math.min(rect[0], rect[2]);
          const top = Math.min(rect[1], rect[3]);
          const width = Math.abs(rect[2] - rect[0]);
          const height = Math.abs(rect[3] - rect[1]);

          const el = document.createElement('a');
          el.className = 'pdf-annotation-link';
          el.style.position = 'absolute';
          el.style.left = `${left * scaleX}px`;
          el.style.top = `${top * scaleY}px`;
          el.style.width = `${width * scaleX}px`;
          el.style.height = `${height * scaleY}px`;
          el.style.display = 'block';
          el.style.zIndex = '30';
          el.style.background = 'transparent';
          el.style.cursor = 'pointer';
          el.setAttribute('aria-label', ann.title || 'PDF link');

          // Provide navigation for external/internal links:
          if (href) {
            // external URL: set href so native navigation works
            el.href = href;
            el.target = '_blank';
            el.rel = 'noopener noreferrer';
          } else if (resolvedInternal) {
            // internal destination: set a hash href for discoverability and add click handler
            el.href = `#page-${resolvedInternal.pageNumber}`;
            el.addEventListener('click', (ev: MouseEvent) => {
              try {
                ev.preventDefault();
                const target = document.querySelector(`[data-page-number="${resolvedInternal!.pageNumber}"]`) as HTMLElement | null;
                if (target) {
                  // center the target page in view
                  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                  // fallback: jump to top if page element not found
                  window.location.hash = `page-${resolvedInternal!.pageNumber}`;
                }
              } catch (err) {

              }
            });
          }

          // forward dblclick on the anchor to word double-click handler so links (single-click)
          // still work but double-click will start accumulation/jump to the correct word.
          el.addEventListener('dblclick', (e: MouseEvent) => {
            try {
              if (!onWordDoubleClick || !canvas || !viewport || !pdfjsLib || !words) return;
              const canvasRect = canvas.getBoundingClientRect();
              const clickX = e.clientX;
              const clickY = e.clientY;

              // try to find a containing word rect; fallback to nearest word center
              let found = -1;
              for (let idx = 0; idx < words.length; idx++) {
                const w = words[idx];
                const tx = pdfjsLib.Util.transform(viewport.transform, w.transform);
                const x = tx[4];
                const y = tx[5];
                const width = w.width * scale;
                const height = w.height * scale * 1.2;
                const top = y - height * 0.85;

                const leftScreen = canvasRect.left + x * (canvasRect.width / canvas.width);
                const topScreen = canvasRect.top + top * (canvasRect.height / canvas.height);
                const rightScreen = leftScreen + width * (canvasRect.width / canvas.width);
                const bottomScreen = topScreen + height * (canvasRect.height / canvas.height);

                if (clickX >= leftScreen && clickX <= rightScreen && clickY >= topScreen && clickY <= bottomScreen) {
                  found = idx;
                  break;
                }
              }

              if (found === -1) {
                // nearest center fallback
                let best = { idx: -1, dist: Infinity };
                for (let idx = 0; idx < words.length; idx++) {
                  const w = words[idx];
                  const tx = pdfjsLib.Util.transform(viewport.transform, w.transform);
                  const x = tx[4];
                  const y = tx[5];
                  const width = w.width * scale;
                  const height = w.height * scale * 1.2;
                  const top = y - height * 0.85;
                  const cx = canvasRect.left + (x + width / 2) * (canvasRect.width / canvas.width);
                  const cy = canvasRect.top + (top + height / 2) * (canvasRect.height / canvas.height);
                  const d = Math.hypot(cx - clickX, cy - clickY);
                  if (d < best.dist) { best = { idx, dist: d }; }
                }
                found = best.idx;
              }

              if (found !== -1) {
                // do not prevent default: allow single-click navigation behavior to remain intact
                onWordDoubleClick(pageNumber, found);
              }
            } catch (err) {

            }
          });

          layer.appendChild(el);
        } catch (err) {

        }
      }
    })();
  }, [annotations, viewport, pdfDoc, scale]);

  // Draw highlights (simplified: remove per-section colored backgrounds)
  useEffect(() => {

    try {
      if (!highlightCanvasRef.current || !viewport || words.length === 0 || !pdfjsLib) return;
      const t0 = performance.now();
      const canvas = highlightCanvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      context.clearRect(0, 0, canvas.width, canvas.height);

      // Draw annotated green fill (persistent across sections)
      if (annotatedIndices && annotatedIndices.length) {
        context.globalCompositeOperation = 'source-over';
        context.fillStyle = 'rgba(144, 238, 144, 0.45)'; // light green (hardcoded)

        const rawRects: { x: number; y: number; width: number; height: number; lineY: number }[] = [];
        for (const idx of annotatedIndices) {
          const w = words[idx];
          if (!w) continue;

          const tx = pdfjsLib.Util.transform(viewport.transform, w.transform);
          const x = tx[4];
          const y = tx[5];
          const width = w.width * scale;
          const height = w.height * scale * 1.2;
          const top = y - height * 0.85;

          rawRects.push({ x, y: top, width, height, lineY: Math.round(y) });
        }

        if (rawRects.length) {
          rawRects.sort((a, b) => (a.lineY - b.lineY) || (a.x - b.x));
          const merged: typeof rawRects = [];
          const lineTolerance = Math.max(2, 2 * scale);

          // Calculate adaptive gap tolerance based on average word width
          // This helps handle titles/headings with wider spacing
          const avgWidth = rawRects.reduce((sum, r) => sum + r.width, 0) / rawRects.length;
          const gapTolerance = Math.max(12 * scale, avgWidth * 0.8);

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

          merged.forEach(r => {
            context.fillRect(r.x, r.y, r.width, r.height);
          });
        }
      }

      // Draw accumulative yellow fill for visited words of the current section only (skip annotated words)
      if (visitedWordInfo && visitedWordInfo.indices && visitedWordInfo.indices.length) {
        context.globalCompositeOperation = 'source-over';
        // Convert hex to rgba with opacity
        const hex = readingHighlightColor.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        context.fillStyle = `rgba(${r}, ${g}, ${b}, 1.0)`;

        const rawRects: { x: number; y: number; width: number; height: number; lineY: number }[] = [];
        // build a Set of annotated indices so we don't draw yellow over green
        const annotatedSet = new Set(annotatedIndices || []);

        for (const idx of visitedWordInfo.indices) {
          if (readingHighlightStyle !== 'underline' && annotatedSet.has(idx)) continue; // skip annotated words unless underlining
          const w = words[idx];
          if (!w) continue;
          if (visitedWordInfo.section !== null && w.sectionIndex !== visitedWordInfo.section) continue;

          const tx = pdfjsLib.Util.transform(viewport.transform, w.transform);
          const x = tx[4];
          const y = tx[5];
          const width = w.width * scale;
          const height = w.height * scale * 1.2;
          const top = y - height * 0.85;

          rawRects.push({ x, y: top, width, height, lineY: Math.round(y) });
        }

        if (rawRects.length) {
          rawRects.sort((a, b) => (a.lineY - b.lineY) || (a.x - b.x));
          const merged: typeof rawRects = [];
          const lineTolerance = Math.max(2, 2 * scale);

          // Calculate adaptive gap tolerance based on average word width
          // This helps handle titles/headings with wider spacing
          const avgWidth = rawRects.reduce((sum, r) => sum + r.width, 0) / rawRects.length;
          const gapTolerance = Math.max(12 * scale, avgWidth * 0.8);

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

          merged.forEach(r => {
            if (readingHighlightStyle === 'underline') {
              // Convert hex to rgba with opacity 1.0 for underline
              const hex = readingHighlightColor.replace('#', '');
              const rVal = parseInt(hex.substring(0, 2), 16);
              const gVal = parseInt(hex.substring(2, 4), 16);
              const bVal = parseInt(hex.substring(4, 6), 16);
              context.fillStyle = `rgba(${rVal}, ${gVal}, ${bVal}, 1.0)`;

              // Draw underline at the bottom
              const underlineHeight = Math.max(2, r.height * 0.1); // 10% of height or at least 2px
              context.fillRect(r.x, r.y + r.height - underlineHeight, r.width, underlineHeight);
            } else {
              context.fillRect(r.x, r.y, r.width, r.height);
            }
          });
        }
      }

      // Draw extra highlight for the currently selected word (stronger)
      if (highlightedWordIndex !== null && words[highlightedWordIndex]) {
        const wordItem = words[highlightedWordIndex];

        // Parse color for current selection
        const hex = readingHighlightColor.replace('#', '');
        const rVal = parseInt(hex.substring(0, 2), 16);
        const gVal = parseInt(hex.substring(2, 4), 16);
        const bVal = parseInt(hex.substring(4, 6), 16);

        context.globalCompositeOperation = 'source-over';

        // Determine style
        if (readingHighlightStyle === 'underline') {
          context.fillStyle = `rgba(${rVal}, ${gVal}, ${bVal}, 1.0)`; // Solid color for active underline
        } else {
          // Darker highlight: darken RGB by 30% and use higher opacity
          const rDark = Math.max(0, Math.floor(rVal * 0.7));
          const gDark = Math.max(0, Math.floor(gVal * 0.7));
          const bDark = Math.max(0, Math.floor(bVal * 0.7));
          context.fillStyle = `rgba(${rDark}, ${gDark}, ${bDark}, 1.0)`;
        }

        const drawRect = (r: { x: number, y: number, width: number, height: number }) => {
          if (readingHighlightStyle === 'underline') {
            // Bolder underline
            const underlineHeight = Math.max(4, r.height * 0.15); // Thicker than visited
            context.fillRect(r.x, r.y + r.height - underlineHeight, r.width, underlineHeight);
          } else {
            context.fillRect(r.x, r.y, r.width, r.height);
          }
        };

        if (highlightMode === 'phrase') {
          // Highlight entire sentence
          const currentSentenceIndex = wordItem.sentenceIndex;
          const sentenceWords = words.filter(w => w.sentenceIndex === currentSentenceIndex);

          const rawRects: { x: number; y: number; width: number; height: number; lineY: number }[] = [];
          for (const w of sentenceWords) {
            const tx = pdfjsLib.Util.transform(viewport.transform, w.transform);
            const x = tx[4];
            const y = tx[5];
            const width = w.width * scale;
            const height = w.height * scale * 1.2;
            const top = y - height * 0.85;
            rawRects.push({ x, y: top, width, height, lineY: Math.round(y) });
          }

          if (rawRects.length) {
            rawRects.sort((a, b) => (a.lineY - b.lineY) || (a.x - b.x));
            const merged: typeof rawRects = [];
            const lineTolerance = Math.max(2, 2 * scale);
            const gapTolerance = Math.max(2, 6 * scale);

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

            merged.forEach(r => {
              drawRect(r);
            });
          }

        } else {
          // Word mode
          const tx = pdfjsLib.Util.transform(viewport.transform, wordItem.transform);
          const x = tx[4];
          const y = tx[5];

          const width = wordItem.width * scale;
          const height = wordItem.height * scale * 1.2;

          drawRect({ x, y: y - height * 0.85, width, height });
        }
      }
      // Draw selection anchor (start point of range selection)
      if (selectionAnchor && selectionAnchor.page === pageNumber && words[selectionAnchor.word]) {
        const wordItem = words[selectionAnchor.word];
        context.strokeStyle = 'rgba(0, 0, 255, 0.8)'; // Blue for anchor
        context.lineWidth = 2;
        context.setLineDash([4, 2]); // Dashed line
        context.globalCompositeOperation = 'source-over';

        const tx = pdfjsLib.Util.transform(viewport.transform, wordItem.transform);
        const x = tx[4];
        const y = tx[5];
        const width = wordItem.width * scale;
        const height = wordItem.height * scale * 1.2;

        context.strokeRect(x, y - height * 0.85, width, height);
        context.setLineDash([]); // Reset dash
      }

      const t1 = performance.now();
      // Draw drag selection (temporary visual feedback)
      if (dragSelection && words.length > 0) {
        const { start, end } = dragSelection;
        // Determine if this page is within the selection range
        const startPage = Math.min(start.page, end.page);
        const endPage = Math.max(start.page, end.page);

        if (pageNumber >= startPage && pageNumber <= endPage) {
          context.globalCompositeOperation = 'source-over';
          context.fillStyle = 'rgba(0, 100, 255, 0.2)'; // Light blue for selection

          let startIndex = 0;
          let endIndex = words.length - 1;

          if (pageNumber === startPage) {
            // If start and end are on the same page
            if (startPage === endPage) {
              // Determine min and max word index to handle reverse drag
              const sWord = start.page === end.page ? start.word : (start.page < end.page ? start.word : end.word);
              const eWord = start.page === end.page ? end.word : (start.page < end.page ? end.word : start.word);

              // Actually, let's simplify. The app logic should normalize start/end or we do it here.
              // Let's assume start/end are just points and we need to find the range.
              // But wait, start is where mouse went down, end is current mouse pos.
              // So they can be inverted.

              const p1 = start;
              const p2 = end;

              // We are on the single page.
              startIndex = Math.min(p1.word, p2.word);
              endIndex = Math.max(p1.word, p2.word);
            } else {
              // Multi-page, this is start page.
              // If start.page is this page, start from start.word.
              // If end.page is this page (reverse drag), start from end.word.
              startIndex = (start.page === pageNumber) ? start.word : end.word;
              // endIndex is end of page
            }
          }

          if (pageNumber === endPage && startPage !== endPage) {
            // Multi-page, this is end page.
            startIndex = 0;
            endIndex = (end.page === pageNumber) ? end.word : start.word;
          }

          if (pageNumber > startPage && pageNumber < endPage) {
            // Middle page, select all
            startIndex = 0;
            endIndex = words.length - 1;
          }

          // Draw rects
          const rawRects: { x: number; y: number; width: number; height: number; lineY: number }[] = [];
          for (let i = startIndex; i <= endIndex; i++) {
            const w = words[i];
            if (!w) continue;
            const tx = pdfjsLib.Util.transform(viewport.transform, w.transform);
            const x = tx[4];
            const y = tx[5];
            const width = w.width * scale;
            const height = w.height * scale * 1.2;
            const top = y - height * 0.85;
            rawRects.push({ x, y: top, width, height, lineY: Math.round(y) });
          }

          if (rawRects.length) {
            // Merge logic (reused)
            rawRects.sort((a, b) => (a.lineY - b.lineY) || (a.x - b.x));
            const merged: typeof rawRects = [];
            const lineTolerance = Math.max(2, 2 * scale);
            const gapTolerance = Math.max(2, 6 * scale);

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

            merged.forEach(r => {
              context.fillRect(r.x, r.y, r.width, r.height);
            });
          }
        }
      }


    } finally {

    }
  }, [words, viewport, highlightedWordIndex, pdfjsLib, visitedWordInfo, annotatedIndices, selectionAnchor, highlightMode, dragSelection, readingHighlightColor, readingHighlightStyle]);

  // NEW: create transparent hit targets for each parsed word so double-click can be detected
  useEffect(() => {

    try {
      const layer = wordLayerRef.current;
      const canvas = pdfCanvasRef.current;
      if (!layer) return;
      layer.innerHTML = '';
      if (!words || !words.length || !viewport || !canvas || !pdfjsLib) return;
      const t0 = performance.now();

      const canvasRect = canvas.getBoundingClientRect();
      const scaleX = canvasRect.width / canvas.width;
      const scaleY = canvasRect.height / canvas.height;

      const handles: { el: HTMLDivElement; handler: (e: MouseEvent) => void }[] = [];

      words.forEach((w, idx) => {
        try {
          const tx = pdfjsLib.Util.transform(viewport.transform, w.transform);
          const x = tx[4];
          const y = tx[5];
          const width = w.width * scale;
          const height = w.height * scale * 1.2;
          const top = y - height * 0.85;

          const el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.left = `${x * scaleX}px`;
          el.style.top = `${top * scaleY}px`;
          el.style.width = `${width * scaleX}px`;
          el.style.height = `${height * scaleY}px`;
          // transparent but accept pointer events
          el.style.background = 'transparent';
          el.style.cursor = 'text';
          el.style.zIndex = '20'; // below annotation links (which use 30)
          el.setAttribute('data-word-index', String(idx));
          el.title = w.str;

          const dbl = (e: MouseEvent) => {
            e.stopPropagation();
            if (onWordDoubleClick) {
              onWordDoubleClick(pageNumber, idx);
            }
          };
          const click = (e: MouseEvent) => {
            e.stopPropagation();
            if (onWordClick) {
              onWordClick(pageNumber, idx, e.shiftKey);
            }
          };
          const mousedown = (e: MouseEvent) => {
            if (isHighlightToolActive) {
              e.stopPropagation();
              e.preventDefault(); // Prevent text selection
              onWordMouseDown(pageNumber, idx);
            }
          };
          const mouseenter = (e: MouseEvent) => {
            if (isHighlightToolActive) {
              // We don't stop propagation here necessarily, but we could
              onWordMouseEnter(pageNumber, idx);
            }
          };

          el.addEventListener('dblclick', dbl);
          el.addEventListener('click', click);
          el.addEventListener('mousedown', mousedown);
          el.addEventListener('mouseenter', mouseenter);

          handles.push({ el, handler: dbl }); // keeping track mainly for cleanup if we needed it

          layer.appendChild(el);
        } catch (err) {
          // ignore word overlay failures for safety

        }
      });
    } finally {

    }
  }, [words, viewport, pdfjsLib, pageNumber, scale, onWordDoubleClick, onWordClick, isHighlightToolActive, onWordMouseDown, onWordMouseEnter]);

  // NEW: Scroll the window so the currently highlighted word is visible and centered based on user preference
  useEffect(() => {

    try {
      if (highlightedWordIndex === null) return;
      if (!viewport || !pdfjsLib) return;
      if (!pdfCanvasRef.current || !innerRef.current) return;
      if (!words || words.length === 0) return;

      const word = words[highlightedWordIndex];
      if (!word) return;

      try {
        const canvas = pdfCanvasRef.current;
        const canvasRect = canvas.getBoundingClientRect();

        // account for CSS scaling of the canvas
        const scaleX = canvasRect.width / canvas.width;
        const scaleY = canvasRect.height / canvas.height;

        const tx = pdfjsLib.Util.transform(viewport.transform, word.transform);
        const y = tx[5];
        const height = word.height * scale * 1.2;
        const top = y - height * 0.85;

        const topViewport = canvasRect.top + top * scaleY;
        const wordCenterViewport = topViewport + (height * scaleY) / 2;
        const wordCenterDoc = window.scrollY + wordCenterViewport;

        // Calculate target scroll position based on preferred ratio
        // ratio 0.0 = top, 1.0 = bottom
        const targetScrollTop = wordCenterDoc - (window.innerHeight * scrollState.current.ratio);

        // Ensure we don't scroll past document bounds
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        const finalScrollTop = Math.max(0, Math.min(targetScrollTop, maxScroll));

        // Check if we actually need to scroll (if it's already close enough, skip to avoid jitter)
        if (Math.abs(window.scrollY - finalScrollTop) > 5) {
          scrollState.current.isAutoScrolling = true;
          window.scrollTo({ top: finalScrollTop, behavior: 'smooth' });

          // Reset auto-scrolling flag after animation
          setTimeout(() => {
            scrollState.current.isAutoScrolling = false;
          }, 600);
        }

      } catch (err) {

      }
    } finally {

    }
  }, [highlightedWordIndex, words, viewport, pdfjsLib, scrollState]);

  // NEW: Listen for manual scrolls to update the preferred ratio
  useEffect(() => {
    const handleScroll = () => {
      if (scrollState.current.isAutoScrolling) return;
      if (highlightedWordIndex === null) return;
      if (!words || !words[highlightedWordIndex] || !viewport || !pdfCanvasRef.current || !pdfjsLib) return;

      const word = words[highlightedWordIndex];
      const canvas = pdfCanvasRef.current;
      const canvasRect = canvas.getBoundingClientRect();
      const scaleY = canvasRect.height / canvas.height;

      const tx = pdfjsLib.Util.transform(viewport.transform, word.transform);
      const y = tx[5];
      const height = word.height * scale * 1.2;
      const top = y - height * 0.85;

      // Current screen position of the word center
      const wordScreenY = canvasRect.top + (top + height / 2) * scaleY;

      // Only update ratio if the word is comfortably within the viewport
      if (wordScreenY > 50 && wordScreenY < window.innerHeight - 50) {
        const ratio = wordScreenY / window.innerHeight;
        // Clamp ratio to reasonable reading area (e.g. 10% to 90%)
        const clamped = Math.max(0.1, Math.min(0.9, ratio));
        scrollState.current.ratio = clamped;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [highlightedWordIndex, words, viewport, pdfjsLib, scrollState]);

  return (
    <div ref={combinedRef} data-page-number={pageNumber} className="bg-white p-4 rounded-lg shadow-lg flex flex-col items-center">
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
        <canvas
          ref={highlightCanvasRef}
          className="absolute top-0 left-0 w-full h-full pointer-events-none"
          style={{ mixBlendMode: 'multiply', zIndex: 10 }} // Add mix-blend-mode and zIndex
        />
        {/* word hit layer sits under annotation anchors so single-click links still work */}
        <div ref={wordLayerRef} className="absolute top-0 left-0 w-full h-full pointer-events-auto" style={{ zIndex: 20 }} />
        {/* annotation layer must be above canvas/highlights and accept pointer events */}
        <div ref={annotationLayerRef} className="absolute top-0 left-0 w-full h-full pointer-events-auto" />
      </div>
      <div className="text-center text-sm text-gray-500 pt-2">Page {pageNumber}</div>
    </div>
  );
});

const MemoPdfPage = React.memo(PdfPage, (prev, next) => {
  // compare only the props that should trigger a repaint
  return prev.pageNumber === next.pageNumber
    && prev.highlightedWordIndex === next.highlightedWordIndex
    && prev.pdfDoc === next.pdfDoc
    && prev.pdfjsLib === next.pdfjsLib
    && prev.annotatedIndices === next.annotatedIndices
    && prev.visitedWordInfo === next.visitedWordInfo
    && prev.scrollState === next.scrollState
    && prev.selectionAnchor === next.selectionAnchor
    && prev.highlightMode === next.highlightMode
    && prev.isHighlightToolActive === next.isHighlightToolActive
    && prev.dragSelection === next.dragSelection
    && prev.readingHighlightColor === next.readingHighlightColor
    && prev.readingHighlightStyle === next.readingHighlightStyle;
});

const App: React.FC = () => {
  const [pdfDoc, setPdfDoc] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightedPosition, setHighlightedPosition] = useState<{ page: number; word: number } | null>(null);
  const [pageWordCounts, setPageWordCounts] = useState<{ [key: number]: number }>({});
  const [pageWords, setPageWords] = useState<{ [key: number]: WordItem[] }>({});
  const [pdfjsLib, setPdfjsLib] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollState = useRef({ ratio: 0.3, isAutoScrolling: false });
  const [selectionAnchor, setSelectionAnchor] = useState<{ page: number; word: number } | null>(null); // NEW
  const [highlightMode, setHighlightMode] = useState<'word' | 'phrase'>('word'); // NEW
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null); // NEW: store raw PDF bytes

  // NEW: Mouse Highlight Tool State
  const [isHighlightToolActive, setIsHighlightToolActive] = useState(false);
  const [dragSelection, setDragSelection] = useState<{ start: { page: number; word: number }; end: { page: number; word: number } } | null>(null);
  const isDraggingRef = useRef(false);

  // NEW: Style Menu State
  const [readingHighlightColor, setReadingHighlightColor] = useState('#facc5a'); // Default yellow
  const [readingHighlightStyle, setReadingHighlightStyle] = useState<'highlight' | 'underline'>('underline'); // NEW
  const [isStyleMenuOpen, setIsStyleMenuOpen] = useState(false);

  // NEW: track visited/highlighted words per page (accumulative by section)
  // visitedWords[page] = { section: number | null, indices: number[] }
  const [visitedWords, setVisitedWords] = useState<{ [page: number]: { section: number | null; indices: number[] } }>({});

  // NEW: annotated words persist across sections -> annotatedWords[page] = { [sectionIndex]: number[] }
  const [annotatedWords, setAnnotatedWords] = useState<{ [page: number]: { [section: number]: number[] } }>({});

  // NEW: refs for accessing state in event handlers without re-binding
  const visitedWordsRef = useRef(visitedWords);
  const annotatedWordsRef = useRef(annotatedWords);

  useEffect(() => { visitedWordsRef.current = visitedWords; }, [visitedWords]);
  useEffect(() => { annotatedWordsRef.current = annotatedWords; }, [annotatedWords]);

  // stable empty visited object so we don't create a new object every render
  const EMPTY_VISITED = useMemo(() => ({ section: null as number | null, indices: [] as number[] }), []);
  // stable empty annotated indices array to avoid re-creating [] on each render
  const EMPTY_ANNOTATED = useMemo(() => [] as number[], []);

  // precompute flattened annotated indices per page in a stable map
  const annotatedIndicesMap = useMemo(() => {
    const m: { [page: number]: number[] } = {};
    for (const key of Object.keys(annotatedWords)) {
      const p = Number(key);
      if (!Number.isFinite(p)) continue;
      const pageMap = annotatedWords[p] || {};
      // type-assert the values are arrays of numbers, then flatten safely
      const vals = Object.values(pageMap) as number[][];
      m[p] = vals.length ? vals.flat() : [];
    }
    return m;
  }, [annotatedWords]);

  // NEW: isAnnotating while 'S' is pressed
  const [isAnnotating, setIsAnnotating] = useState(false);
  const isErasingRef = useRef(false);

  const markVisited = useCallback((page: number, word: number) => {
    setVisitedWords(prev => {
      const next = { ...prev };
      const wordsOnPage = pageWords[page] || [];
      const section = wordsOnPage[word]?.sectionIndex ?? null;

      // if the stored section for this page differs, reset to the new section
      if (!next[page] || next[page].section !== section) {
        next[page] = { section, indices: [word] };
      } else {
        const set = new Set(next[page].indices);
        set.add(word);
        next[page] = { section, indices: Array.from(set) };
      }
      return next;
    });
  }, [pageWords]);

  // NEW: mark annotated (persistent) words
  const markAnnotated = useCallback((page: number, word: number) => {
    setAnnotatedWords(prev => {
      const next = { ...prev };
      const wordsOnPage = pageWords[page] || [];
      const section = wordsOnPage[word]?.sectionIndex ?? null;
      if (section === null) return prev;

      const pageMap = { ...(next[page] || {}) };
      const set = new Set(pageMap[section] || []);
      set.add(word);
      pageMap[section] = Array.from(set);
      next[page] = pageMap;
      return next;
    });
  }, [pageWords]);

  // NEW: unmark visited (remove highlight from a visited word)
  const unmarkVisited = useCallback((page: number, word: number) => {
    setVisitedWords(prev => {
      const next = { ...prev };
      const entry = next[page];
      if (!entry) return prev;

      const filtered = (entry.indices || []).filter(i => i !== word);
      if (filtered.length === 0) {
        // clear section info if nothing remains
        next[page] = { section: null, indices: [] };
      } else {
        next[page] = { section: entry.section, indices: filtered };
      }
      return next;
    });
  }, []);

  // NEW: unmark annotated (remove persistent annotation)
  const unmarkAnnotated = useCallback((page: number, word: number) => {
    setAnnotatedWords(prev => {
      const next = { ...prev };
      const pageMap = { ...(next[page] || {}) };
      // determine section for the word from pageWords
      const wordsOnPage = pageWords[page] || [];
      const section = wordsOnPage[word]?.sectionIndex ?? null;
      if (section === null || !(pageMap[section] || []).length) return prev;

      const filtered = (pageMap[section] || []).filter(i => i !== word);
      if (filtered.length) {
        pageMap[section] = filtered;
      } else {
        delete pageMap[section];
      }

      // if no sections left for this page, remove the page entry
      if (Object.keys(pageMap).length) {
        next[page] = pageMap;
      } else {
        delete next[page];
      }

      return next;
    });
  }, [pageWords]);

  // ----- NEW PERF: precompute navigation and batch marking -----
  // navigation maps stored in a ref to avoid re-renders during rapid navigation
  const pageNavRef = useRef<{
    [page: number]: {
      nextInSection: number[];
      prevInSection: number[];
      firstOfNextSectionForIndex: number[];
    }
  }>({});

  // populate pageNavRef when words are parsed
  const computeNavigationForPage = useCallback((page: number, words: WordItem[]) => {
    const nextInSection = new Array<number>(words.length).fill(-1);
    const prevInSection = new Array<number>(words.length).fill(-1);
    const firstIndexOfSection = new Map<number, number>();
    const sectionOrder: number[] = [];

    // first pass: record first index for each section and section order
    for (let i = 0; i < words.length; i++) {
      const s = words[i].sectionIndex;
      if (!firstIndexOfSection.has(s)) {
        firstIndexOfSection.set(s, i);
        sectionOrder.push(s);
      }
    }

    // prevInSection: last seen index per section
    const lastSeen = new Map<number, number>();
    for (let i = 0; i < words.length; i++) {
      const s = words[i].sectionIndex;
      if (lastSeen.has(s)) {
        prevInSection[i] = lastSeen.get(s)!;
      }
      lastSeen.set(s, i);
    }

    // nextInSection: scan from right to left
    const nextSeen = new Map<number, number>();
    for (let i = words.length - 1; i >= 0; i--) {
      const s = words[i].sectionIndex;
      if (nextSeen.has(s)) {
        nextInSection[i] = nextSeen.get(s)!;
      }
      nextSeen.set(s, i);
    }

    // build map from section -> first index and array of sections in order
    const firstOfNextSectionForIndex = new Array<number>(words.length).fill(-1);
    const sectionToFirstIndex = new Map<number, number>();
    for (const [s, idx] of firstIndexOfSection.entries()) {
      sectionToFirstIndex.set(s, idx);
    }

    // create mapping of section -> next section's first index
    const nextSectionFirst = new Map<number, number | null>();
    for (let i = 0; i < sectionOrder.length; i++) {
      const s = sectionOrder[i];
      const nextS = sectionOrder[i + 1];
      nextSectionFirst.set(s, nextS !== undefined ? sectionToFirstIndex.get(nextS)! : null);
    }

    for (let i = 0; i < words.length; i++) {
      const s = words[i].sectionIndex;
      const nextFirst = nextSectionFirst.get(s);
      firstOfNextSectionForIndex[i] = nextFirst !== null && nextFirst !== undefined ? nextFirst : -1;
    }

    pageNavRef.current[page] = { nextInSection, prevInSection, firstOfNextSectionForIndex };
  }, []);

  // batching mark requests with RAF so many quick keypresses don't cause many renders
  const pendingMarksRef = useRef<{ page: number; word: number; annotate: boolean | 'erase' }[]>([]);
  const markScheduledRef = useRef<number | null>(null);
  const scheduleMark = useCallback((page: number, word: number, annotate: boolean | 'erase') => {
    pendingMarksRef.current.push({ page, word, annotate });
    if (markScheduledRef.current !== null) return;
    markScheduledRef.current = requestAnimationFrame(() => {
      markScheduledRef.current = null;
      const marks = pendingMarksRef.current.splice(0);
      // de-duplicate by page:word with annotate flag treated separately
      const keySet = new Set<string>();
      const visitUpdates: { page: number; word: number }[] = [];
      const annotUpdates: { page: number; word: number }[] = [];
      const eraseUpdates: { page: number; word: number }[] = [];

      for (const m of marks) {
        const k = `${m.page}:${m.word}:${m.annotate}`;
        if (keySet.has(k)) continue;
        keySet.add(k);
        if (m.annotate === 'erase') eraseUpdates.push({ page: m.page, word: m.word });
        else if (m.annotate) annotUpdates.push({ page: m.page, word: m.word });
        else visitUpdates.push({ page: m.page, word: m.word });
      }

      if (visitUpdates.length) {
        setVisitedWords(prev => {
          const next = { ...prev };
          for (const u of visitUpdates) {
            const wordsOnPage = pageWords[u.page] || [];
            const section = wordsOnPage[u.word]?.sectionIndex ?? null;
            const currentEntry = next[u.page];
            if (!currentEntry) {
              next[u.page] = { section, indices: [u.word] };
            } else if (currentEntry.section === section) {
              const s = new Set(currentEntry.indices);
              s.add(u.word);
              next[u.page] = { section, indices: Array.from(s) };
            } else if (currentEntry.section === null && section !== null) {
              // Migration from null section (initial load) to valid section
              // Keep indices that belong to the new section
              const validIndices = currentEntry.indices.filter(idx => wordsOnPage[idx]?.sectionIndex === section);
              const s = new Set(validIndices);
              s.add(u.word);
              next[u.page] = { section, indices: Array.from(s) };
            } else {
              next[u.page] = { section, indices: [u.word] };
            }
          }
          return next;
        });
      }

      if (annotUpdates.length) {
        setAnnotatedWords(prev => {
          const next = { ...prev };
          for (const u of annotUpdates) {
            const wordsOnPage = pageWords[u.page] || [];
            const section = wordsOnPage[u.word]?.sectionIndex ?? null;
            if (section === null) continue;
            const pageMap = { ...(next[u.page] || {}) };
            const s = new Set(pageMap[section] || []);
            s.add(u.word);
            pageMap[section] = Array.from(s);
            next[u.page] = pageMap;
          }
          return next;
        });
      }

      if (eraseUpdates.length) {
        setAnnotatedWords(prev => {
          const next = { ...prev };
          for (const u of eraseUpdates) {
            const pageMap = { ...(next[u.page] || {}) };
            const wordsOnPage = pageWords[u.page] || [];
            const section = wordsOnPage[u.word]?.sectionIndex ?? null;
            if (section === null || !(pageMap[section] || []).length) continue;

            const filtered = (pageMap[section] || []).filter(i => i !== u.word);
            if (filtered.length) {
              pageMap[section] = filtered;
            } else {
              delete pageMap[section];
            }

            if (Object.keys(pageMap).length) {
              next[u.page] = pageMap;
            } else {
              delete next[u.page];
            }
          }
          return next;
        });
      }
    });
  }, [pageWords]);

  // stable double-click handler (same function identity each render)
  const handleWordDoubleClick = useCallback((p: number, idx: number) => {
    const markFnAnnot = isAnnotating ? (isErasingRef.current ? 'erase' : true) : false;
    setHighlightMode('word');
    setHighlightedPosition({ page: p, word: idx });
    // batch marking to RAF for speed
    scheduleMark(p, idx, markFnAnnot);
    pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [isAnnotating, scheduleMark]);

  // NEW: handle single click (with shift support for range selection)
  const handleWordClick = useCallback((p: number, idx: number, isShift: boolean) => {
    if (isShift) {
      if (!selectionAnchor) {
        // Start selection
        setSelectionAnchor({ page: p, word: idx });
      } else {
        // End selection (Range)
        const startPage = Math.min(selectionAnchor.page, p);
        const endPage = Math.max(selectionAnchor.page, p);

        // iterate through pages and words to mark them
        for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
          const words = pageWords[pageNum] || [];
          if (!words.length) continue;

          let startIndex = 0;
          let endIndex = words.length - 1;

          if (pageNum === startPage) {
            // if start and end are on same page, we need to be careful with indices
            if (startPage === endPage) {
              startIndex = Math.min(selectionAnchor.word, idx);
              endIndex = Math.max(selectionAnchor.word, idx);
            } else {
              // if this is the start page (but not end page), start from anchor word (if anchor is on this page)
              // actually anchor is on startPage (by definition of min above, unless we swapped)
              // Wait, if selectionAnchor.page < p, then startPage is selectionAnchor.page.
              // So on startPage, we start from selectionAnchor.word to end.
              // If selectionAnchor.page > p, then startPage is p. So on startPage we start from idx to end.
              // Let's simplify:
              startIndex = (selectionAnchor.page === pageNum) ? selectionAnchor.word : idx;
              // wait, if startPage != endPage, then on startPage we go from startWord to END of page.
              // on endPage we go from 0 to endWord.
              // on middle pages we go 0 to length-1.
            }
          }

          if (pageNum === startPage && pageNum !== endPage) {
            // Multi-page selection: Start Page
            // Determine start word index on this page
            const startWord = (selectionAnchor.page === pageNum) ? selectionAnchor.word : idx;
            startIndex = startWord;
            endIndex = words.length - 1;
          } else if (pageNum === endPage && pageNum !== startPage) {
            // Multi-page selection: End Page
            startIndex = 0;
            const endWord = (selectionAnchor.page === pageNum) ? selectionAnchor.word : idx;
            endIndex = endWord;
          } else if (pageNum > startPage && pageNum < endPage) {
            // Middle pages (full page)
            startIndex = 0;
            endIndex = words.length - 1;
          }

          // Mark the range
          for (let i = startIndex; i <= endIndex; i++) {
            scheduleMark(pageNum, i, true); // Always annotate for range selection
          }
        }

        setSelectionAnchor(null); // Clear anchor after selection
      }
    } else {
      // Normal click
      setHighlightedPosition({ page: p, word: idx });
      setHighlightMode('word');
      // Mark the clicked word as visited so it gets the yellow highlight
      // We use isAnnotating to decide if we should also annotate (green)
      scheduleMark(p, idx, isAnnotating ? (isErasingRef.current ? 'erase' : true) : false);
    }
  }, [selectionAnchor, pageWords, scheduleMark, isAnnotating]);

  // NEW: Mouse Drag Handlers
  const handleWordMouseDown = useCallback((page: number, word: number) => {
    if (!isHighlightToolActive) return;
    isDraggingRef.current = true;
    setDragSelection({ start: { page, word }, end: { page, word } });
  }, [isHighlightToolActive]);

  const handleWordMouseEnter = useCallback((page: number, word: number) => {
    if (!isHighlightToolActive || !isDraggingRef.current) return;
    setDragSelection(prev => {
      if (!prev) return null;
      return { ...prev, end: { page, word } };
    });
  }, [isHighlightToolActive]);

  // Global mouse up to finish drag
  useEffect(() => {
    const handleMouseUp = () => {
      if (isDraggingRef.current && dragSelection) {
        isDraggingRef.current = false;

        // Commit the selection
        const { start, end } = dragSelection;
        const startPage = Math.min(start.page, end.page);
        const endPage = Math.max(start.page, end.page);

        // Determine mode based on start word
        let isEraseMode = false;
        const startWordItem = pageWords[start.page]?.[start.word];
        if (startWordItem) {
          const sec = startWordItem.sectionIndex;
          const pageAnnots = annotatedWordsRef.current[start.page];
          if (pageAnnots && pageAnnots[sec] && pageAnnots[sec].includes(start.word)) {
            isEraseMode = true;
          }
        }

        for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
          const words = pageWords[pageNum] || [];
          if (!words.length) continue;

          let startIndex = 0;
          let endIndex = words.length - 1;

          if (pageNum === startPage) {
            if (startPage === endPage) {
              startIndex = Math.min(start.word, end.word);
              endIndex = Math.max(start.word, end.word);
            } else {
              startIndex = (start.page === pageNum) ? start.word : end.word;
            }
          }

          if (pageNum === endPage && startPage !== endPage) {
            endIndex = (end.page === pageNum) ? end.word : start.word;
          }

          for (let i = startIndex; i <= endIndex; i++) {
            scheduleMark(pageNum, i, isEraseMode ? 'erase' : true); // Mark as annotated (green) or erase
          }
        }

        setDragSelection(null);
      }
    };

    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [dragSelection, pageWords, scheduleMark]);

  // Load PDF.js library
  useEffect(() => {
    const loadPdfJs = async () => {
      try {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.async = true;

        script.onload = () => {
          const pdfjs = (window as any).pdfjsLib;
          if (pdfjs) {
            pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            setPdfjsLib(pdfjs);
          }
        };

        document.head.appendChild(script);
      } catch (err) {

        setError('Failed to load PDF library');
      }
    };

    loadPdfJs();
  }, []);

  // NEW: listen for 's' key down/up to toggle annotation mode
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 's') {
        if (isAnnotating) return; // Prevent repeat
        setIsAnnotating(true);

        // Determine erase mode based on current highlighted word
        let shouldErase = false;
        if (highlightedPosition) {
          const { page, word } = highlightedPosition;
          const wordsOnPage = pageWords[page] || [];
          const w = wordsOnPage[word];
          if (w) {
            const sec = w.sectionIndex;
            const pageAnnots = annotatedWordsRef.current[page];
            if (pageAnnots && pageAnnots[sec] && pageAnnots[sec].includes(word)) {
              shouldErase = true;
            }
          }
        }
        isErasingRef.current = shouldErase;

        // Immediately mark/unmark the current word (or phrase) if we are on one
        if (highlightedPosition) {
          const { page, word } = highlightedPosition;

          if (highlightMode === 'phrase') {
            const wordsOnPage = pageWords[page] || [];
            const currentWordItem = wordsOnPage[word];
            if (currentWordItem) {
              const currentSentenceIndex = currentWordItem.sentenceIndex;
              // Mark all words in the current sentence
              for (let i = 0; i < wordsOnPage.length; i++) {
                if (wordsOnPage[i].sentenceIndex === currentSentenceIndex) {
                  scheduleMark(page, i, shouldErase ? 'erase' : true);
                }
              }
            }
          } else {
            // Word mode: just mark the current word
            scheduleMark(page, word, shouldErase ? 'erase' : true);
          }
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 's') {
        setIsAnnotating(false);
        isErasingRef.current = false;
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [highlightedPosition, scheduleMark, highlightMode, pageWords, isAnnotating]);

  const rafRef = useRef<number | null>(null);
  const scheduleSetHighlighted = useCallback((next: { page: number; word: number }) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setHighlightedPosition(next);
      rafRef.current = null;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!pdfDoc || !highlightedPosition) return;

      const { page, word } = highlightedPosition;
      const wordsOnPage = pageWords[page] || [];

      // choose marking function based on annotation mode
      // NOTE: we batch marking via scheduleMark for performance
      const markAnnot = isAnnotating ? (isErasingRef.current ? 'erase' : true) : false;

      // helper: clear visited highlights for sections earlier than targetSection.
      const clearPreviousVisited = (targetPage: number, targetSection: number | null) => {
        // only affect visitedWords (do not touch annotatedWords)
        setVisitedWords(prev => {
          const next: typeof prev = { ...prev };
          for (const keyStr of Object.keys(next)) {
            const pNum = Number(keyStr);
            if (!Number.isFinite(pNum)) continue;
            const entry = next[pNum];
            if (!entry || entry.section === null) continue;

            // clear entire earlier pages
            if (pNum < targetPage) {
              next[pNum] = { section: null, indices: [] };
              continue;
            }

            // on same page, clear sections whose index is less than targetSection
            if (pNum === targetPage && targetSection !== null && entry.section < targetSection) {
              next[pNum] = { section: null, indices: [] };
            }
          }
          return next;
        });
      };

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setHighlightMode('word');

        if (!wordsOnPage.length) {
          // fallback: go to next page start
          if (page + 1 <= pdfDoc.numPages) {
            const nextPage = page + 1;
            const wordsNext = pageWords[nextPage] || [];
            const nextWord = wordsNext.length ? 0 : 0;

            clearPreviousVisited(nextPage, wordsNext.length ? wordsNext[0].sectionIndex : null);

            const next = { page: nextPage, word: nextWord };
            // schedule highlight and marking (batched)
            scheduleSetHighlighted(next);
            scheduleMark(next.page, next.word, markAnnot);
            pageRefs.current[nextPage - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }

        const currentWord = wordsOnPage[word];
        if (!currentWord) return;

        let nextWordIndex = -1;

        if (highlightMode === 'phrase') {
          // If we were in phrase mode, ArrowRight should move to the start of the NEXT phrase and switch to word mode
          const currentSentenceIndex = currentWord.sentenceIndex;
          const currentSectionIndex = currentWord.sectionIndex;
          let nextWordIndex = -1;

          // Find the first word of the next sentence OR next section part of same sentence
          for (let i = word + 1; i < wordsOnPage.length; i++) {
            if (wordsOnPage[i].sentenceIndex > currentSentenceIndex ||
              (wordsOnPage[i].sentenceIndex === currentSentenceIndex && wordsOnPage[i].sectionIndex !== currentSectionIndex)) {
              nextWordIndex = i;
              break;
            }
          }

          if (nextWordIndex !== -1) {
            const next = { page, word: nextWordIndex };
            scheduleSetHighlighted(next);
            scheduleMark(next.page, next.word, markAnnot);
            return;
          }

          // Go to next page's first sentence
          for (let p = page + 1; p <= pdfDoc.numPages; p++) {
            const wordsNextPage = pageWords[p] || [];
            if (wordsNextPage.length) {
              clearPreviousVisited(p, wordsNextPage[0].sectionIndex);
              const next = { page: p, word: 0 };
              scheduleSetHighlighted(next);
              scheduleMark(next.page, next.word, markAnnot);
              pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              return;
            }
          }

          // Fallback: stay on current word if no next phrase found
          scheduleSetHighlighted({ page, word });
          scheduleMark(page, word, markAnnot);
          return;
        } else {
          // Word Mode Navigation
          const nav = pageNavRef.current[page];
          if (nav) {
            // fast lookup using precomputed nav
            nextWordIndex = nav.nextInSection[word];
            if (nextWordIndex === -1) {
              const candidate = nav.firstOfNextSectionForIndex[word];
              if (candidate !== -1) nextWordIndex = candidate;
            }
          } else {
            // fallback slow path
            const currentSection = currentWord.sectionIndex;
            for (let i = word + 1; i < wordsOnPage.length; i++) {
              if (wordsOnPage[i].sectionIndex === currentSection) {
                nextWordIndex = i;
                break;
              }
            }
            if (nextWordIndex === -1) {
              const nextSectionIndex = wordsOnPage
                .map(w => w.sectionIndex)
                .filter(idx => idx > currentSection)
                .sort((a, b) => a - b)[0];
              if (nextSectionIndex !== undefined) {
                const firstOfNext = wordsOnPage.findIndex(w => w.sectionIndex === nextSectionIndex);
                if (firstOfNext !== -1) nextWordIndex = firstOfNext;
              }
            }
          }
        }

        if (nextWordIndex !== -1) {
          const next = { page, word: nextWordIndex };
          scheduleSetHighlighted(next);
          scheduleMark(next.page, next.word, markAnnot);
          return;
        }

        // otherwise go to next page's first section first word
        for (let p = page + 1; p <= pdfDoc.numPages; p++) {
          const wordsNextPage = pageWords[p] || [];
          if (wordsNextPage.length) {
            clearPreviousVisited(p, wordsNextPage[0].sectionIndex);
            const next = { page: p, word: 0 };
            scheduleSetHighlighted(next);
            scheduleMark(next.page, next.word, markAnnot);
            pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }

      } else if (event.key === 'Tab') {
        event.preventDefault();
        setHighlightMode('phrase');

        if (event.shiftKey) {
          // Shift+Tab: Previous Phrase
          if (!wordsOnPage.length) {
            // Fallback to previous page logic similar to ArrowLeft but for phrases
            if (page > 1) {
              // ... logic to go to last phrase of prev page
              // For simplicity, reuse the ArrowLeft fallback logic but adapted for phrase
              const prevPage = page - 1;
              const prevWords = pageWords[prevPage] || [];
              if (prevWords.length) {
                const lastSentenceIndex = prevWords[prevWords.length - 1].sentenceIndex;
                let startOfLast = prevWords.length - 1;
                while (startOfLast > 0 && prevWords[startOfLast - 1].sentenceIndex === lastSentenceIndex) {
                  startOfLast--;
                }
                const next = { page: prevPage, word: startOfLast };
                scheduleSetHighlighted(next);
                // Mark it
                for (let i = startOfLast; i < prevWords.length; i++) {
                  scheduleMark(prevPage, i, markAnnot);
                }
                pageRefs.current[prevPage - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }
            return;
          }

          const currentWord = wordsOnPage[word];
          if (!currentWord) return;

          // Unhighlight entire current sentence
          const currentSentenceIndex = currentWord.sentenceIndex;
          for (let i = word; i >= 0; i--) {
            if (wordsOnPage[i].sentenceIndex === currentSentenceIndex) {
              if (isAnnotating) unmarkAnnotated(page, i); else unmarkVisited(page, i);
            } else {
              break;
            }
          }
          for (let i = word + 1; i < wordsOnPage.length; i++) {
            if (wordsOnPage[i].sentenceIndex === currentSentenceIndex) {
              if (isAnnotating) unmarkAnnotated(page, i); else unmarkVisited(page, i);
            } else {
              break;
            }
          }

          let prevWordIndex = -1;
          // Find start of previous sentence
          for (let i = word - 1; i >= 0; i--) {
            if (wordsOnPage[i].sentenceIndex < currentSentenceIndex) {
              const prevSentenceIndex = wordsOnPage[i].sentenceIndex;
              let startOfPrev = i;
              while (startOfPrev > 0 && wordsOnPage[startOfPrev - 1].sentenceIndex === prevSentenceIndex) {
                startOfPrev--;
              }
              prevWordIndex = startOfPrev;
              break;
            }
          }

          if (prevWordIndex !== -1) {
            const next = { page, word: prevWordIndex };
            scheduleSetHighlighted(next);
            // Mark new sentence
            const newSentenceIndex = wordsOnPage[prevWordIndex].sentenceIndex;
            for (let i = prevWordIndex; i < wordsOnPage.length; i++) {
              if (wordsOnPage[i].sentenceIndex === newSentenceIndex) {
                scheduleMark(page, i, markAnnot);
              } else {
                break;
              }
            }
            return;
          }

          // Go to previous page's last sentence
          for (let p = page - 1; p >= 1; p--) {
            const wordsPrevPage = pageWords[p] || [];
            if (wordsPrevPage.length) {
              const lastSentenceIndex = wordsPrevPage[wordsPrevPage.length - 1].sentenceIndex;
              let startOfLast = wordsPrevPage.length - 1;
              while (startOfLast > 0 && wordsPrevPage[startOfLast - 1].sentenceIndex === lastSentenceIndex) {
                startOfLast--;
              }
              const next = { page: p, word: startOfLast };
              scheduleSetHighlighted(next);
              for (let i = startOfLast; i < wordsPrevPage.length; i++) {
                scheduleMark(p, i, markAnnot);
              }
              pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              return;
            }
          }

        } else {
          // Tab: Next Phrase
          if (!wordsOnPage.length) {
            // Fallback next page
            if (page + 1 <= pdfDoc.numPages) {
              const nextPage = page + 1;
              const wordsNext = pageWords[nextPage] || [];
              if (wordsNext.length) {
                clearPreviousVisited(nextPage, wordsNext[0].sectionIndex);
                const next = { page: nextPage, word: 0 };
                scheduleSetHighlighted(next);
                const firstSentenceIndex = wordsNext[0].sentenceIndex;
                for (let i = 0; i < wordsNext.length; i++) {
                  if (wordsNext[i].sentenceIndex === firstSentenceIndex) {
                    scheduleMark(nextPage, i, markAnnot);
                  } else {
                    break;
                  }
                }
                pageRefs.current[nextPage - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }
            return;
          }

          const currentWord = wordsOnPage[word];
          if (!currentWord) return;

          const currentSentenceIndex = currentWord.sentenceIndex;
          const currentSectionIndex = currentWord.sectionIndex;

          // Check if current phrase is partially highlighted
          const currentSentenceIndices: number[] = [];
          // Scan backwards
          for (let i = word; i >= 0; i--) {
            if (wordsOnPage[i].sentenceIndex === currentSentenceIndex && wordsOnPage[i].sectionIndex === currentSectionIndex) {
              currentSentenceIndices.push(i);
            } else break;
          }
          // Scan forwards
          for (let i = word + 1; i < wordsOnPage.length; i++) {
            if (wordsOnPage[i].sentenceIndex === currentSentenceIndex && wordsOnPage[i].sectionIndex === currentSectionIndex) {
              currentSentenceIndices.push(i);
            } else break;
          }

          let markedCount = 0;
          if (markAnnot) {
            const pageAnnots = annotatedWordsRef.current[page];
            if (pageAnnots) {
              for (const idx of currentSentenceIndices) {
                const sec = wordsOnPage[idx].sectionIndex;
                if (pageAnnots[sec] && pageAnnots[sec].includes(idx)) markedCount++;
              }
            }
          } else {
            const pageVisited = visitedWordsRef.current[page];
            if (pageVisited && pageVisited.indices) {
              for (const idx of currentSentenceIndices) {
                // Check if word's section matches visited section
                if (pageVisited.section === wordsOnPage[idx].sectionIndex && pageVisited.indices.includes(idx)) {
                  markedCount++;
                }
              }
            }
          }

          if (markedCount > 0 && markedCount < currentSentenceIndices.length) {
            // Partially highlighted: highlight the rest
            for (const idx of currentSentenceIndices) {
              scheduleMark(page, idx, markAnnot);
            }
            return;
          }
          let nextWordIndex = -1;

          // Find the first word of the next sentence OR next section part of same sentence
          for (let i = word + 1; i < wordsOnPage.length; i++) {
            if (wordsOnPage[i].sentenceIndex > currentSentenceIndex ||
              (wordsOnPage[i].sentenceIndex === currentSentenceIndex && wordsOnPage[i].sectionIndex !== currentSectionIndex)) {
              nextWordIndex = i;
              break;
            }
          }

          if (nextWordIndex !== -1) {
            const next = { page, word: nextWordIndex };
            scheduleSetHighlighted(next);

            const newSentenceIndex = wordsOnPage[nextWordIndex].sentenceIndex;
            for (let i = nextWordIndex; i < wordsOnPage.length; i++) {
              if (wordsOnPage[i].sentenceIndex === newSentenceIndex) {
                scheduleMark(page, i, markAnnot);
              } else {
                break;
              }
            }
            return;
          }

          // Go to next page's first sentence
          for (let p = page + 1; p <= pdfDoc.numPages; p++) {
            const wordsNextPage = pageWords[p] || [];
            if (wordsNextPage.length) {
              clearPreviousVisited(p, wordsNextPage[0].sectionIndex);
              const next = { page: p, word: 0 };
              scheduleSetHighlighted(next);

              const firstSentenceIndex = wordsNextPage[0].sentenceIndex;
              for (let i = 0; i < wordsNextPage.length; i++) {
                if (wordsNextPage[i].sentenceIndex === firstSentenceIndex) {
                  scheduleMark(p, i, markAnnot);
                } else {
                  break;
                }
              }
              pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              return;
            }
          }
        }

      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setHighlightMode('word');

        if (!wordsOnPage.length) {
          if (page > 1) {
            if (isAnnotating) unmarkAnnotated(page, word);
            else unmarkVisited(page, word);

            const prevPage = page - 1;
            const prevWords = pageWords[prevPage] || [];
            const lastIndex = prevWords.length ? prevWords.length - 1 : 0;
            const next = { page: prevPage, word: lastIndex };
            scheduleSetHighlighted(next);
            scheduleMark(next.page, next.word, markAnnot);
            pageRefs.current[prevPage - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }

        const currentWord = wordsOnPage[word];
        if (!currentWord) return;
        const nav = pageNavRef.current[page];

        // Unmark current word
        if (isAnnotating) unmarkAnnotated(page, word); else unmarkVisited(page, word);

        let prevWordIndex = -1;
        // Word Mode Navigation
        if (nav) {
          prevWordIndex = nav.prevInSection[word];
          if (prevWordIndex === -1) {
            const currentSection = currentWord.sectionIndex;
            const prevSections = Array.from(new Set(wordsOnPage.map(w => w.sectionIndex))).filter((idx): idx is number => typeof idx === 'number' && idx < currentSection).sort((a, b) => b - a);
            if (prevSections.length) {
              prevWordIndex = wordsOnPage.findIndex(w => w.sectionIndex === prevSections[0]);
            }
          }
        } else {
          const currentSection = currentWord.sectionIndex;
          for (let i = word - 1; i >= 0; i--) {
            if (wordsOnPage[i].sectionIndex === currentSection) {
              prevWordIndex = i;
              break;
            }
          }
          if (prevWordIndex === -1) {
            const prevSectionIndex = wordsOnPage
              .map(w => w.sectionIndex)
              .filter(idx => idx < currentSection)
              .sort((a, b) => b - a)[0];
            if (prevSectionIndex !== undefined) {
              const firstOfPrev = wordsOnPage.findIndex(w => w.sectionIndex === prevSectionIndex);
              if (firstOfPrev !== -1) prevWordIndex = firstOfPrev;
            }
          }
        }

        if (prevWordIndex !== -1) {
          const next = { page, word: prevWordIndex };
          scheduleSetHighlighted(next);
          scheduleMark(next.page, next.word, markAnnot);
          return;
        }

        // otherwise go to previous page's last section last word
        for (let p = page - 1; p >= 1; p--) {
          const wordsPrevPage = pageWords[p] || [];
          if (wordsPrevPage.length) {
            const nextWord = wordsPrevPage.length - 1;
            scheduleMark(p, nextWord, markAnnot);
            const next = { page: p, word: nextWord };
            scheduleSetHighlighted(next);
            pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }

      } else if (event.key === 'ArrowDown') {
        // existing ArrowDown behaviour (jump to next section)
        event.preventDefault();
        const { page, word } = highlightedPosition;
        const wordsOnThisPage = pageWords[page] || [];
        if (!wordsOnThisPage.length) return;

        const currentWord = wordsOnThisPage[word];
        if (!currentWord) return;

        const currentSection = currentWord.sectionIndex;
        const nav = pageNavRef.current[page];

        let nextSectionFirstIndex = -1;
        if (nav) {
          nextSectionFirstIndex = nav.firstOfNextSectionForIndex[word];
        } else {
          const nextSectionIndex = wordsOnThisPage
            .map(w => w.sectionIndex)
            .filter(idx => idx > currentSection)
            .sort((a, b) => a - b)[0];

          if (nextSectionIndex !== undefined) {
            nextSectionFirstIndex = wordsOnThisPage.findIndex(w => w.sectionIndex === nextSectionIndex);
          }
        }

        if (nextSectionFirstIndex !== -1) {
          // clear visited highlights from previous sections (and earlier pages)
          clearPreviousVisited(page, wordsOnThisPage[nextSectionFirstIndex].sectionIndex);

          const next = { page, word: nextSectionFirstIndex };
          scheduleSetHighlighted(next);
          scheduleMark(next.page, next.word, markAnnot);
          pageRefs.current[page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }

        for (let p = page + 1; p <= pdfDoc.numPages; p++) {
          const wordsNextPage = pageWords[p] || [];
          if (wordsNextPage.length) {
            const firstSectionIndex = wordsNextPage[0].sectionIndex;
            const nextWordIndex = wordsNextPage.findIndex(w => w.sectionIndex === firstSectionIndex);

            // clear visited highlights from previous sections/pages before moving
            clearPreviousVisited(p, firstSectionIndex !== undefined ? firstSectionIndex : null);

            const next = { page: p, word: nextWordIndex !== -1 ? nextWordIndex : 0 };
            scheduleSetHighlighted(next);
            scheduleMark(next.page, next.word, markAnnot);
            pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }
      } else if (event.key === 'ArrowUp') {
        // inverse of ArrowDown: restart the current section from its first word
        event.preventDefault();
        const { page, word } = highlightedPosition;
        const wordsOnThisPage = pageWords[page] || [];
        if (!wordsOnThisPage.length) return;

        const currentWord = wordsOnThisPage[word];
        if (!currentWord) return;

        const currentSection = currentWord.sectionIndex;

        if (currentSection !== null) {
          if (isAnnotating) {
            setAnnotatedWords(prev => {
              const next = { ...prev };
              const pageMap = { ...(next[page] || {}) };
              if (!pageMap[currentSection]) return prev; // nothing to remove
              delete pageMap[currentSection];
              if (Object.keys(pageMap).length) {
                next[page] = pageMap;
              } else {
                delete next[page];
              }
              return next;
            });
          } else {
            setVisitedWords(prev => {
              const next = { ...prev };
              const entry = next[page];
              if (!entry) return prev;
              // only clear if the stored section matches the current section
              if (entry.section === currentSection) {
                next[page] = { section: null, indices: [] };
              }
              return next;
            });
          }
        }

        const firstOfSection = wordsOnThisPage.findIndex(w => w.sectionIndex === currentSection);
        if (firstOfSection !== -1) {
          const next = { page, word: firstOfSection };
          scheduleSetHighlighted(next);
          scheduleMark(next.page, next.word, markAnnot);
          pageRefs.current[page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [pdfDoc, highlightedPosition, pageWordCounts, pageWords, markVisited, markAnnotated, unmarkVisited, unmarkAnnotated, isAnnotating, scheduleSetHighlighted, scheduleMark, highlightMode]);

  const processFile = async (file: File) => {
    if (!pdfjsLib) {
      setError('PDF library is still loading. Please wait a moment and try again.');
      return;
    }

    if (file.type !== 'application/pdf') {
      setError('Please select a PDF file.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setPdfDoc(null);
    setPdfBytes(null);
    setHighlightedPosition(null);
    setPageWordCounts({});
    setPageWords({});

    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const buffer = e.target?.result as ArrayBuffer;
          const typedArray = new Uint8Array(buffer);
          // Create a copy for pdf-lib because pdf.js might transfer the buffer to a worker
          setPdfBytes(new Uint8Array(typedArray));

          const loadingTask = pdfjsLib.getDocument(typedArray);
          const doc = await loadingTask.promise;
          setPdfDoc(doc);
          setHighlightedPosition({ page: 1, word: 0 });
          // mark initial word as visited so highlight is accumulative from the start
          // use scheduled mark for fast initial responsiveness
          scheduleMark(1, 0, false);
          setIsLoading(false);
        } catch (err) {
          setError('Error loading PDF document. The file might be corrupted or protected.');

          setIsLoading(false);
        }
      };
      reader.onerror = () => {
        setError('Failed to read the file.');
        setIsLoading(false);
      };
      reader.readAsArrayBuffer(file);
    } catch (err) {
      setError('Error loading PDF document.');

      setIsLoading(false);
    }
  };

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      processFile(file);
    }
  }, [pdfjsLib, scheduleMark]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  }, [pdfjsLib, scheduleMark]);

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const savePdfWithHighlights = async () => {
    if (!pdfBytes || !pdfDoc) return;

    try {
      const pdfDocLib = await PDFDocument.load(pdfBytes);
      const pages = pdfDocLib.getPages();

      // Iterate over all pages with annotations
      for (const [pageNumStr, indices] of Object.entries(annotatedIndicesMap as Record<string, number[]>)) {
        const pageNum = parseInt(pageNumStr, 10); // 1-based
        if (isNaN(pageNum) || pageNum < 1 || pageNum > pages.length) continue;

        const page = pages[pageNum - 1]; // 0-based
        const wordsOnPage = pageWords[pageNum] || [];

        // 1. Collect all highlighted word rects on this page
        const rawRects: { x: number; y: number; width: number; height: number; lineY: number }[] = [];

        for (const idx of indices) {
          const word = wordsOnPage[idx];
          if (!word) continue;

          // Word transform: [scaleX, skewY, skewX, scaleY, x, y]
          const x = word.transform[4];
          const y = word.transform[5];
          const width = word.width;
          const height = word.height;

          // In PDF user space (y increases upwards), y is usually the baseline.
          // We want the bounding box.
          // Based on visual rendering logic: top = y - height * 0.85 (in viewport coords where y is down)
          // In PDF coords (y up): 
          // The word.transform[5] (y) is the baseline.
          // We need to cover the text.
          // Let's approximate the text box relative to baseline:
          // Bottom ≈ y - height * 0.2
          // Top ≈ y + height * 0.8

          // Let's use the same logic as the visual renderer but adapted for PDF coords
          // Visual: top = y - height * 0.85, height = height * 1.2
          // So visual bottom = y - height * 0.85 + height * 1.2 = y + height * 0.35
          // In PDF (y up), this flips.
          // PDF Bottom = y - height * 0.35
          // PDF Top = y + height * 0.85

          const pdfBottom = y - (height * 0.35);
          const pdfHeight = height * 1.2;

          rawRects.push({
            x: x,
            y: pdfBottom,
            width: width,
            height: pdfHeight,
            lineY: Math.round(y) // Use baseline for line grouping
          });
        }

        if (rawRects.length === 0) continue;

        // 2. Merge adjacent rects into lines
        // Sort by line (Y) then X
        // Note: In PDF, higher Y is higher up. So sorting by Y descending might make sense for reading order,
        // but for grouping, we just need to group similar Ys.
        rawRects.sort((a, b) => (b.lineY - a.lineY) || (a.x - b.x));

        const mergedRects: typeof rawRects = [];
        const lineTolerance = 5; // Tolerance for same line
        const gapTolerance = 10; // Tolerance for gap between words

        let current = rawRects[0];
        for (let i = 1; i < rawRects.length; i++) {
          const next = rawRects[i];

          // Check if on same line
          if (Math.abs(next.lineY - current.lineY) <= lineTolerance) {
            // Check if adjacent (next.x should be close to current.x + current.width)
            const currentRight = current.x + current.width;
            // Allow some overlap or small gap
            if (next.x <= currentRight + gapTolerance) {
              // Merge
              const newX = Math.min(current.x, next.x);
              const newRight = Math.max(currentRight, next.x + next.width);
              const newBottom = Math.min(current.y, next.y); // min y is lower bottom
              const newTop = Math.max(current.y + current.height, next.y + next.height);

              current = {
                x: newX,
                y: newBottom,
                width: newRight - newX,
                height: newTop - newBottom,
                lineY: current.lineY // Keep representative lineY
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
          // QuadPoints are 8 numbers: x1 y1 x2 y2 x3 y3 x4 y4
          // (BL, BR, TR, TL) - Counter-clockwise order starting from Bottom-Left? 
          // Spec says: "The coordinates of the four corners of the quadrilateral are specified in the order lower-left, lower-right, upper-right, and upper-left."
          // BL: (x, y)
          // BR: (x + w, y)
          // TR: (x + w, y + h)
          // TL: (x, y + h)

          const quadPoints = [
            rect.x, rect.y,                                // BL
            rect.x + rect.width, rect.y,                   // BR
            rect.x + rect.width, rect.y + rect.height,     // TR
            rect.x, rect.y + rect.height                   // TL
          ];

          // Create the annotation dictionary
          const highlightAnnot = pdfDocLib.context.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height], // Bounding box
            QuadPoints: quadPoints,
            C: [0.56, 0.93, 0.56], // RGB color (Light Green)
            F: 4, // Flags: 4 = Print
          });

          // Register the annotation to get a reference
          const highlightAnnotRef = pdfDocLib.context.register(highlightAnnot);

          // Add annotation to page
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
  };

  const triggerFileSelect = () => fileInputRef.current?.click();

  const handleWordsParsed = useCallback((pageNumber: number, words: WordItem[]) => {
    setPageWords(prev => ({ ...prev, [pageNumber]: words }));
    setPageWordCounts(prev => ({ ...prev, [pageNumber]: words.length }));
    // compute fast navigation maps
    computeNavigationForPage(pageNumber, words);
  }, [computeNavigationForPage]);

  const renderContent = () => {
    if (!pdfjsLib) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center p-8">
          <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-blue-600"></div>
          <p className="mt-4 text-lg text-gray-700 font-semibold">Loading PDF library...</p>
        </div>
      );
    }

    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center p-8">
          <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-blue-600"></div>
          <p className="mt-4 text-lg text-gray-700 font-semibold">Analyzing your document...</p>
          <p className="text-gray-500">This might take a moment.</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center bg-red-50 border border-red-200 rounded-lg p-8">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="mt-4 text-lg text-red-700 font-semibold">An Error Occurred</p>
          <p className="text-red-600">{error}</p>
          <button
            onClick={() => { setError(null); triggerFileSelect(); }}
            className="mt-6 px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }

    if (pdfDoc) {
      return (
        <div className="p-4 md:p-8 space-y-8 relative">
          <div className="fixed bottom-8 right-8 z-50 flex flex-col gap-4">
            <button
              onClick={savePdfWithHighlights}
              className="bg-green-600 text-white p-4 rounded-full shadow-lg hover:bg-green-700 transition-colors flex items-center justify-center"
              title="Save PDF with Highlights"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
            </button>
            <button
              onClick={() => setIsHighlightToolActive(!isHighlightToolActive)}
              className={`${isHighlightToolActive ? 'bg-yellow-500' : 'bg-blue-600'} text-white p-4 rounded-full shadow-lg hover:opacity-90 transition-colors flex items-center justify-center`}
              title={isHighlightToolActive ? "Disable Highlight Tool" : "Enable Highlight Tool"}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          </div>

          {/* Style Menu Button */}
          <div className="fixed bottom-8 right-24 z-50">
            <button
              onClick={() => setIsStyleMenuOpen(!isStyleMenuOpen)}
              className="bg-indigo-600 text-white p-4 rounded-full shadow-lg hover:bg-indigo-700 transition-colors flex items-center justify-center"
              title="Style Settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
              </svg>
            </button>

            {isStyleMenuOpen && (
              <div className="absolute bottom-16 right-0 bg-white p-4 rounded-lg shadow-xl border border-gray-200 w-64 mb-2">
                <h3 className="font-bold text-gray-700 mb-3">Highlight Styles</h3>

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-600 mb-1">Reading Highlight</label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {[
                      { label: 'Yellow', value: '#facc5a' },
                      { label: 'Green', value: '#7dc868' },
                      { label: 'Blue', value: '#5c9aff' },
                      { label: 'Red', value: '#ff6b6b' },
                      { label: 'Purple', value: '#c885da' },
                    ].map((color) => (
                      <button
                        key={color.value}
                        onClick={() => setReadingHighlightColor(color.value)}
                        className={`w-8 h-8 rounded-full border-2 transition-transform ${readingHighlightColor === color.value
                          ? 'border-gray-600 scale-110'
                          : 'border-transparent hover:scale-105'
                          }`}
                        style={{ backgroundColor: color.value }}
                        title={color.label}
                        aria-label={color.label}
                      />
                    ))}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setReadingHighlightStyle('highlight')}
                      className={`px-3 py-1 text-xs rounded border ${readingHighlightStyle === 'highlight' ? 'bg-blue-100 border-blue-500 text-blue-700' : 'bg-white border-gray-300 text-gray-600'}`}
                    >
                      Highlight
                    </button>
                    <button
                      onClick={() => setReadingHighlightStyle('underline')}
                      className={`px-3 py-1 text-xs rounded border ${readingHighlightStyle === 'underline' ? 'bg-blue-100 border-blue-500 text-blue-700' : 'bg-white border-gray-300 text-gray-600'}`}
                    >
                      Underline
                    </button>
                  </div>
                </div>

                <div className="text-xs text-gray-400 pt-2 border-t">
                  Customize the style for your reading progress.
                </div>
              </div>
            )}
          </div>
          {Array.from({ length: pdfDoc.numPages }, (_, i) => {
            const annotatedIndices = annotatedIndicesMap[i + 1] || [];

            return (
              <MemoPdfPage
                key={`page-${i + 1}`}
                ref={el => pageRefs.current[i] = el}
                pageNumber={i + 1}
                pdfDoc={pdfDoc}
                highlightedWordIndex={highlightedPosition?.page === i + 1 ? highlightedPosition.word : null}
                // pass visited info (section + indices) for this page so highlights accumulate by section
                visitedWordInfo={visitedWords[i + 1] ?? EMPTY_VISITED}
                annotatedIndices={annotatedIndices.length ? annotatedIndices : EMPTY_ANNOTATED}
                onWordsParsed={handleWordsParsed}
                pdfjsLib={pdfjsLib}
                onWordDoubleClick={handleWordDoubleClick}
                onWordClick={handleWordClick}
                selectionAnchor={selectionAnchor}
                scrollState={scrollState}
                highlightMode={highlightMode}
                isHighlightToolActive={isHighlightToolActive}
                dragSelection={dragSelection}
                onWordMouseDown={handleWordMouseDown}
                onWordMouseEnter={handleWordMouseEnter}
                readingHighlightColor={readingHighlightColor}
                readingHighlightStyle={readingHighlightStyle}
              />
            );
          })}
        </div>
      );
    }

    // fallback empty content
    return (
      <div className="p-8 flex flex-col items-center justify-center min-h-[60vh]">
        <div
          className="w-full max-w-2xl border-2 border-dashed border-gray-300 rounded-lg p-8 text-center bg-white"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16v-4a4 4 0 014-4h2a4 4 0 014 4v4m-6-4v8" />
          </svg>
          <p className="mt-4 text-lg text-gray-700 font-medium">Drop a PDF here or</p>
          <div className="mt-4">
            <button
              onClick={triggerFileSelect}
              className="px-5 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              Select PDF
            </button>
          </div>

          {/* Highlight Mode Toggle Removed */}\n

          <p className="mt-3 text-sm text-gray-500">You can also press and hold "S" while double-clicking words to toggle annotation mode.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>
    );
  }; // end renderContent

  // main App render
  return (
    <div className="min-h-screen bg-gray-50">
      {renderContent()}
    </div>
  );
};

export default App;