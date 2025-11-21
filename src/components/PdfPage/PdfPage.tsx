import React, { useState, useCallback, useRef, useEffect } from 'react';
import { WordItem, PdfPageProps } from '../../types';
import { PDF_SCALE } from '../../constants';

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
  const scale = PDF_SCALE;

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

        // Post-process to identify page numbers
        const wordsBySection: { [key: number]: any[] } = {};
        parsedWords.forEach(w => {
          if (!wordsBySection[w.sectionIndex]) wordsBySection[w.sectionIndex] = [];
          wordsBySection[w.sectionIndex].push(w);
        });

        Object.values(wordsBySection).forEach(sectionWords => {
          // Check 1: Isolation (3 words or fewer)
          if (sectionWords.length > 3) return;

          // Check 2: Content (Numeric or Roman)
          const text = sectionWords.map(w => w.str).join('').trim();
          const isNumeric = /^\d+$/.test(text);
          // Simple roman check (case insensitive)
          const isRoman = /^[ivxlcdm]+$/i.test(text);

          if (!isNumeric && !isRoman) return;

          // Check 3: Position (Header or Footer 15%)
          // Use the first word's transform to determine position
          const w = sectionWords[0];
          const tx = pdfjsLib.Util.transform(pageViewport.transform, w.transform);
          const y = tx[5]; // y coordinate in viewport

          const isHeader = y < pageViewport.height * 0.15;
          const isFooter = y > pageViewport.height * 0.85;

          if (isHeader || isFooter) {
            sectionWords.forEach(w => w.isPageNumber = true);
          }
        });

        // Filter out page numbers completely so they are ignored by navigation and rendering
        const filteredWords = parsedWords.filter(w => !w.isPageNumber);

        if (!isCancelled) {
          setWords(filteredWords);
          // send filtered words to parent so it can manage sections/navigation
          onWordsParsed(pageNumber, filteredWords);
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
          if (annotatedSet.has(idx)) continue; // skip annotated words
          const w = words[idx];
          if (!w) continue;

          // Skip page numbers for all styles (redundant if filtered, but safe to keep or remove)
          // if (w.isPageNumber) continue;

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

        let highlightedText = wordItem.str;
        if (highlightMode === 'phrase') {
          const currentSentenceIndex = wordItem.sentenceIndex;
          const sentenceWords = words.filter(w => w.sentenceIndex === currentSentenceIndex);
          highlightedText = sentenceWords.map(w => w.str).join('');
        }



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

export const MemoPdfPage = React.memo(PdfPage, (prev, next) => {
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
