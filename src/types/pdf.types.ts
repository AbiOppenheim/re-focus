export interface WordItem {
    str: string;
    transform: number[];
    width: number;
    height: number;
    sectionIndex: number;
    sentenceIndex: number;
}

export interface HighlightedPosition {
    page: number;
    word: number;
}

export interface VisitedWordInfo {
    section: number | null;
    indices: number[];
}

export interface AnnotatedWordsMap {
    [page: number]: {
        [section: number]: number[];
    };
}

export interface SelectionAnchor {
    page: number;
    word: number;
}

export interface DragSelection {
    start: { page: number; word: number };
    end: { page: number; word: number };
}

export interface PdfPageProps {
    pdfDoc: any;
    pageNumber: number;
    highlightedWordIndex: number | null;
    visitedWordInfo?: VisitedWordInfo;
    annotatedIndices?: number[];
    onWordsParsed: (pageNumber: number, words: WordItem[]) => void;
    pdfjsLib: any;
    onWordDoubleClick?: (pageNumber: number, wordIndex: number) => void;
    onWordClick?: (pageNumber: number, wordIndex: number, isShift: boolean) => void;
    selectionAnchor?: SelectionAnchor | null;
    scrollState: React.MutableRefObject<{ ratio: number; isAutoScrolling: boolean }>;
    highlightMode: 'word' | 'phrase';
    isHighlightToolActive: boolean;
    dragSelection: DragSelection | null;
    onWordMouseDown: (pageNumber: number, wordIndex: number) => void;
    onWordMouseEnter: (pageNumber: number, wordIndex: number) => void;
    readingHighlightColor: string;
    readingHighlightStyle: 'highlight' | 'underline';
}
