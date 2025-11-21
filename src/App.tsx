import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { PdfPage, StyleMenu, Toolbar, FileUpload } from './components';
import { WordItem } from './types';
import { savePdfWithHighlights, loadPdfFile } from './utils';
import { DEFAULT_READING_HIGHLIGHT_COLOR } from './constants';

// Copy the entire App component from the original file (lines 923-2481)
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

          // Find the first word of the next sentence (ignore section breaks within same sentence)
          for (let i = word + 1; i < wordsOnPage.length; i++) {
            if (wordsOnPage[i].sentenceIndex > currentSentenceIndex) {

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

          // Find the first word of the next sentence (ignore section breaks within same sentence)
          for (let i = word + 1; i < wordsOnPage.length; i++) {
            if (wordsOnPage[i].sentenceIndex > currentSentenceIndex) {
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

  const handleSavePdf = async () => {
    if (!pdfBytes || !pdfDoc) return;
    await savePdfWithHighlights(pdfBytes, annotatedIndicesMap, pageWords);
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
              onClick={handleSavePdf}
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
              <PdfPage
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
