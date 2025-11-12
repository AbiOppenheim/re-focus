import React, { useState, useCallback, useRef, useEffect } from 'react';

interface WordItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  sectionIndex: number;
}

const PdfPage = React.forwardRef<HTMLDivElement, {
  pdfDoc: any;
  pageNumber: number;
  highlightedWordIndex: number | null;
  visitedWordInfo?: { section: number | null; indices: number[] };
  annotatedIndices?: number[];
  onWordsParsed: (pageNumber: number, words: WordItem[]) => void;
  pdfjsLib: any;
  onWordDoubleClick?: (pageNumber: number, wordIndex: number) => void; // added prop
}>(({ pdfDoc, pageNumber, highlightedWordIndex, visitedWordInfo = { section: null, indices: [] }, annotatedIndices = [], onWordsParsed, pdfjsLib, onWordDoubleClick }, ref) => {
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
          console.warn('Failed to get annotations for page', pageNumber, ae);
        }

        const parsedWords: any[] = [];
        let sectionIndex = 0;
        let lastY = null;
        let lastLineHeight = null;
        const lineHeightTolerance = 1.5; // Multiplier for detecting paragraph breaks
        
        for (const item of textContent.items) {
          if (!item.str.trim()) continue;

          const currentY = item.transform[5];
          const currentHeight = Math.abs(item.transform[3]);
          
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
              });
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
        console.error(`Failed to render page ${pageNumber}`, error);
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
            console.warn('Failed to resolve internal destination', err);
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
                console.warn('Internal link navigation failed', err);
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
               console.warn('dblclick forward failed', err);
             }
           });
 
           layer.appendChild(el);
         } catch (err) {
           console.warn('Failed to create annotation element', err);
         }
      }
    })();
  }, [annotations, viewport, pdfDoc, scale]);
  
  // NEW: create transparent hit targets for each parsed word so double-click can be detected
  useEffect(() => {
    const layer = wordLayerRef.current;
    const canvas = pdfCanvasRef.current;
    if (!layer) return;
    layer.innerHTML = '';
    if (!words || !words.length || !viewport || !canvas || !pdfjsLib) return;

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
        el.addEventListener('dblclick', dbl);
        handles.push({ el, handler: dbl });

        layer.appendChild(el);
      } catch (err) {
        // ignore word overlay failures for safety
        console.warn('word overlay failed', err);
      }
    });

    return () => {
      // cleanup listeners
      for (const h of handles) {
        h.el.removeEventListener('dblclick', h.handler);
      }
      layer.innerHTML = '';
    };
  }, [words, viewport, pdfjsLib, pageNumber, scale, onWordDoubleClick]);
  
  // Draw highlights (simplified: remove per-section colored backgrounds)
  useEffect(() => {
    if (!highlightCanvasRef.current || !viewport || words.length === 0 || !pdfjsLib) return;

    const canvas = highlightCanvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;
    
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Draw annotated green fill (persistent across sections)
    if (annotatedIndices && annotatedIndices.length) {
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = 'rgba(144, 238, 144, 0.45)'; // light green

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

    // Draw accumulative yellow fill for visited words of the current section only (skip annotated words)
    if (visitedWordInfo && visitedWordInfo.indices && visitedWordInfo.indices.length) {
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = 'rgba(255, 223, 0, 0.45)'; // warm yellow

      const rawRects: { x: number; y: number; width: number; height: number; lineY: number }[] = [];
      // build a Set of annotated indices so we don't draw yellow over green
      const annotatedSet = new Set(annotatedIndices || []);

      for (const idx of visitedWordInfo.indices) {
        if (annotatedSet.has(idx)) continue; // skip annotated words
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

    // Draw extra highlight for the currently selected word (stronger)
    if (highlightedWordIndex !== null && words[highlightedWordIndex]) {
      const wordItem = words[highlightedWordIndex];
      
      context.strokeStyle = 'rgba(255, 0, 0, 0.9)';
      context.lineWidth = 2;
      context.globalCompositeOperation = 'source-over';

      const tx = pdfjsLib.Util.transform(viewport.transform, wordItem.transform);
      const x = tx[4];
      const y = tx[5];
      
      const width = wordItem.width * scale;
      const height = wordItem.height * scale * 1.2;
      
      context.strokeRect(x, y - height * 0.85, width, height);
    }

  }, [words, viewport, highlightedWordIndex, pdfjsLib, visitedWordInfo, annotatedIndices]);
  
  // NEW: Scroll the window so the currently highlighted word is visible and centered when it changes
  useEffect(() => {
    if (highlightedWordIndex === null) return;
    if (!viewport || !pdfjsLib) return;
    if (!pdfCanvasRef.current || !innerRef.current) return;
    if (!words || words.length === 0) return;

    const word = words[highlightedWordIndex];
    if (!word) return;

    try {
      const sectionIndex = word.sectionIndex;
      // collect all words in the same section
      const sectionWords = words
        .map((w, idx) => ({ w, idx }))
        .filter(o => o.w.sectionIndex === sectionIndex);

      if (!sectionWords.length) return;

      const canvas = pdfCanvasRef.current;
      const canvasRect = canvas.getBoundingClientRect();

      // account for CSS scaling of the canvas
      const scaleX = canvasRect.width / canvas.width;
      const scaleY = canvasRect.height / canvas.height;

      // compute bounding box (in screen coordinates) for the whole section
      let minTop = Infinity;
      let maxBottom = -Infinity;

      for (const { w: ww } of sectionWords) {
        const tx = pdfjsLib.Util.transform(viewport.transform, ww.transform);
        const x = tx[4];
        const y = tx[5];
        const width = ww.width * scale;
        const height = ww.height * scale * 1.2;
        const top = y - height * 0.85;

        const topScreen = canvasRect.top + top * scaleY;
        const bottomScreen = canvasRect.top + (top + height) * scaleY;

        minTop = Math.min(minTop, topScreen);
        maxBottom = Math.max(maxBottom, bottomScreen);
      }

      // if the section is already visible within padding, do nothing
      const padding = window.innerHeight * 0.1;
      if (minTop >= window.scrollY + padding && maxBottom <= window.scrollY + window.innerHeight - padding) {
        return;
      }

      // center the section vertically in the window
      const centerScreenY = (minTop + maxBottom) / 2;
      const targetScrollTop = Math.max(0, window.scrollY + centerScreenY - window.innerHeight / 2);
      window.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
    } catch (err) {
      // ignore scroll errors
      console.error('Scrolling to highlighted section failed', err);
    }
  }, [highlightedWordIndex, words, viewport, pdfjsLib]);

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
        <canvas ref={highlightCanvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />
        {/* word hit layer sits under annotation anchors so single-click links still work */}
        <div ref={wordLayerRef} className="absolute top-0 left-0 w-full h-full pointer-events-auto" style={{ zIndex: 20 }} />
        {/* annotation layer must be above canvas/highlights and accept pointer events */}
        <div ref={annotationLayerRef} className="absolute top-0 left-0 w-full h-full pointer-events-auto" />
      </div>
      <div className="text-center text-sm text-gray-500 pt-2">Page {pageNumber}</div>
    </div>
  );
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

  // NEW: track visited/highlighted words per page (accumulative by section)
  // visitedWords[page] = { section: number | null, indices: number[] }
  const [visitedWords, setVisitedWords] = useState<{ [page: number]: { section: number | null; indices: number[] } }>({});

  // NEW: annotated words persist across sections -> annotatedWords[page] = { [sectionIndex]: number[] }
  const [annotatedWords, setAnnotatedWords] = useState<{ [page: number]: { [section: number]: number[] } }>({});

  // NEW: isAnnotating while 'S' is pressed
  const [isAnnotating, setIsAnnotating] = useState(false);

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
        console.error('Failed to load PDF.js', err);
        setError('Failed to load PDF library');
      }
    };

    loadPdfJs();
  }, []);

  // NEW: listen for 's' key down/up to toggle annotation mode
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 's') {
        setIsAnnotating(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 's') {
        setIsAnnotating(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!pdfDoc || !highlightedPosition) return;

      const { page, word } = highlightedPosition;
      const wordsOnPage = pageWords[page] || [];

      // choose marking function based on annotation mode
      const markFn = isAnnotating ? markAnnotated : markVisited;
      const unmarkFn = isAnnotating ? unmarkAnnotated : unmarkVisited;

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (!wordsOnPage.length) {
          // fallback: go to next page start
          if (page + 1 <= pdfDoc.numPages) {
            const nextPage = page + 1;
            const wordsNext = pageWords[nextPage] || [];
            const nextWord = wordsNext.length ? 0 : 0;
            const next = { page: nextPage, word: nextWord };
            setHighlightedPosition(next);
            markFn(next.page, next.word);
            pageRefs.current[nextPage - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }

        const currentWord = wordsOnPage[word];
        if (!currentWord) return;
        const currentSection = currentWord.sectionIndex;

        // find next word in same section
        let nextWordIndex = -1;
        for (let i = word + 1; i < wordsOnPage.length; i++) {
          if (wordsOnPage[i].sectionIndex === currentSection) {
            nextWordIndex = i;
            break;
          }
        }

        if (nextWordIndex !== -1) {
          const next = { page, word: nextWordIndex };
          setHighlightedPosition(next);
          markFn(next.page, next.word);
          return;
        }

        // no more words in current section on this page -> find first word of next section on same page
        const nextSectionIndex = wordsOnPage
          .map(w => w.sectionIndex)
          .filter(idx => idx > currentSection)
          .sort((a,b) => a - b)[0];

        if (nextSectionIndex !== undefined) {
          const firstOfNext = wordsOnPage.findIndex(w => w.sectionIndex === nextSectionIndex);
          if (firstOfNext !== -1) {
            const next = { page, word: firstOfNext };
            setHighlightedPosition(next);
            markFn(next.page, next.word);
            pageRefs.current[page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }

        // otherwise go to next page's first section first word
        for (let p = page + 1; p <= pdfDoc.numPages; p++) {
          const wordsNextPage = pageWords[p] || [];
          if (wordsNextPage.length) {
            const next = { page: p, word: 0 };
            setHighlightedPosition(next);
            markFn(next.page, next.word);
            pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }

      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (!wordsOnPage.length) {
          if (page > 1) {
            // unmark current if possible
            unmarkFn(page, word);

            const prevPage = page - 1;
            const prevWords = pageWords[prevPage] || [];
            const lastIndex = prevWords.length ? prevWords.length - 1 : 0;
            const next = { page: prevPage, word: lastIndex };
            setHighlightedPosition(next);
            // mark the newly highlighted word
            markFn(next.page, next.word);
            pageRefs.current[prevPage - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }

        const currentWord = wordsOnPage[word];
        if (!currentWord) return;
        const currentSection = currentWord.sectionIndex;

        // UNHIGHLIGHT current word before moving left
        unmarkFn(page, word);

        // find previous word in same section
        let prevWordIndex = -1;
        for (let i = word - 1; i >= 0; i--) {
          if (wordsOnPage[i].sectionIndex === currentSection) {
            prevWordIndex = i;
            break;
          }
        }

        if (prevWordIndex !== -1) {
          const next = { page, word: prevWordIndex };
          setHighlightedPosition(next);
          // mark the new highlighted word
          markFn(next.page, next.word);
          return;
        }

        // no previous word in this section: move to first word of previous section on same page (inverse of right)
        const prevSectionIndex = wordsOnPage
          .map(w => w.sectionIndex)
          .filter(idx => idx < currentSection)
          .sort((a,b) => b - a)[0];

        if (prevSectionIndex !== undefined) {
          // find first word with that section (start of that previous section)
          const firstOfPrev = wordsOnPage.findIndex(w => w.sectionIndex === prevSectionIndex);
          if (firstOfPrev !== -1) {
            const next = { page, word: firstOfPrev };
            setHighlightedPosition(next);
            markFn(next.page, next.word);
            pageRefs.current[page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }

        // otherwise go to previous page's last section last word
        for (let p = page - 1; p >= 1; p--) {
          const wordsPrevPage = pageWords[p] || [];
          if (wordsPrevPage.length) {
            const lastIndex = wordsPrevPage.length - 1;
            const next = { page: p, word: lastIndex };
            setHighlightedPosition(next);
            markFn(next.page, next.word);
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

        const nextSectionIndex = wordsOnThisPage
          .map(w => w.sectionIndex)
          .filter(idx => idx > currentSection)
          .sort((a,b) => a - b)[0];

        if (nextSectionIndex !== undefined) {
          const nextWordIndex = wordsOnThisPage.findIndex(w => w.sectionIndex === nextSectionIndex);
          if (nextWordIndex !== -1) {
            const next = { page, word: nextWordIndex };
            setHighlightedPosition(next);
            markFn(next.page, next.word);
            pageRefs.current[page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }

        for (let p = page + 1; p <= pdfDoc.numPages; p++) {
          const wordsNextPage = pageWords[p] || [];
          if (wordsNextPage.length) {
            const firstSectionIndex = wordsNextPage[0].sectionIndex;
            const nextWordIndex = wordsNextPage.findIndex(w => w.sectionIndex === firstSectionIndex);
            const next = { page: p, word: nextWordIndex !== -1 ? nextWordIndex : 0 };
            setHighlightedPosition(next);
            markFn(next.page, next.word);
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

        // NEW: clear all highlights for the whole section when jumping to its first word.
        // If we're in annotate mode, remove the persistent annotations for that section.
        // Otherwise, clear the visited (accumulative) highlights for that section.
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
          setHighlightedPosition(next);
          markFn(next.page, next.word);
          pageRefs.current[page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [pdfDoc, highlightedPosition, pageWordCounts, pageWords, markVisited, markAnnotated, unmarkVisited, unmarkAnnotated, isAnnotating]);

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
    setHighlightedPosition(null);
    setPageWordCounts({});
    setPageWords({});

    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const typedArray = new Uint8Array(e.target?.result as ArrayBuffer);
          const loadingTask = pdfjsLib.getDocument(typedArray);
          const doc = await loadingTask.promise;
          setPdfDoc(doc);
          setHighlightedPosition({ page: 1, word: 0 });
          // mark initial word as visited so highlight is accumulative from the start
          markVisited(1, 0);
          setIsLoading(false);
        } catch (err) {
          setError('Error loading PDF document. The file might be corrupted or protected.');
          console.error(err);
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
      console.error(err);
      setIsLoading(false);
    }
  };

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      processFile(file);
    }
  }, [pdfjsLib]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  }, [pdfjsLib]);
  
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const triggerFileSelect = () => fileInputRef.current?.click();

  const handleWordsParsed = useCallback((pageNumber: number, words: WordItem[]) => {
    setPageWords(prev => ({ ...prev, [pageNumber]: words }));
    setPageWordCounts(prev => ({ ...prev, [pageNumber]: words.length }));
  }, []);

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
        <div className="p-4 md:p-8 space-y-8">
          {Array.from({ length: pdfDoc.numPages }, (_, i) => {
            // compute annotated indices for this page (flatten all sections)
            const pageAnnotatedMap = annotatedWords[i + 1] || {};
            const annotatedIndices = Object.values(pageAnnotatedMap).flat();

            return (
              <PdfPage
                key={`page-${i + 1}`}
                ref={el => pageRefs.current[i] = el}
                pageNumber={i + 1}
                pdfDoc={pdfDoc}
                highlightedWordIndex={highlightedPosition?.page === i + 1 ? highlightedPosition.word : null}
                // pass visited info (section + indices) for this page so highlights accumulate by section
                visitedWordInfo={visitedWords[i + 1] || { section: null, indices: [] }}
                annotatedIndices={annotatedIndices}
                onWordsParsed={handleWordsParsed}
                pdfjsLib={pdfjsLib}
                onWordDoubleClick={(p, idx) => {
                  const markFn = isAnnotating ? markAnnotated : markVisited;
                  setHighlightedPosition({ page: p, word: idx });
                  markFn(p, idx);
                  pageRefs.current[p - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
              />
            );
          })}
        </div>
      );
    }

    return (
      <div 
        onDrop={handleDrop} 
        onDragOver={handleDragOver}
        className="flex flex-col items-center justify-center h-full border-4 border-dashed border-gray-300 hover:border-blue-500 transition-colors duration-300 rounded-2xl p-8 cursor-pointer"
        onClick={triggerFileSelect}
      >
        <input
          type="file"
          accept="application/pdf"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden"
        />
        <svg xmlns="http://www.w3.org/2000/svg" className="h-24 w-24 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <p className="mt-4 text-xl font-semibold text-gray-700">Drag & drop your PDF here</p>
        <p className="text-gray-500">or click to select a file</p>
      </div>
    );
  };
  
  return (
    <div className="min-h-screen bg-gray-100 font-sans">
      <header className="bg-white shadow-md sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-800">PDF Word Highlighter</h1>
          {pdfDoc && (
            <button
              onClick={triggerFileSelect}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              Load Another PDF
            </button>
          )}
        </div>
      </header>
      <main className="container mx-auto p-4 md:p-8">
        <div className="bg-white rounded-lg shadow-xl min-h-[60vh] flex flex-col justify-center">
          {renderContent()}
        </div>
      </main>
      <footer className="text-center py-4 text-gray-500 text-sm">
        <p>Built with React, Tailwind CSS, and PDF.js</p>
        {pdfDoc && <p className="text-xs mt-1">Use Left/Right arrow keys to navigate highlights. Hold "S" while navigating to annotate (green).</p>}
      </footer>
    </div>
  );
};

export default App;