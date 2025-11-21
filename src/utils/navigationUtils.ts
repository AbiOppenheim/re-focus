import { WordItem } from '../types';

export interface NavigationMap {
    nextInSection: number[];
    prevInSection: number[];
    firstOfNextSectionForIndex: number[];
}

/**
 * Compute navigation maps for a page to enable fast word/phrase navigation
 */
export function computeNavigationForPage(words: WordItem[]): NavigationMap {
    const nextInSection = new Array<number>(words.length).fill(-1);
    const prevInSection = new Array<number>(words.length).fill(-1);
    const firstIndexOfSection = new Map<number, number>();
    const sectionOrder: number[] = [];

    // First pass: record first index for each section and section order
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

    // Build map from section -> first index and array of sections in order
    const firstOfNextSectionForIndex = new Array<number>(words.length).fill(-1);
    const sectionToFirstIndex = new Map<number, number>();
    for (const [s, idx] of firstIndexOfSection.entries()) {
        sectionToFirstIndex.set(s, idx);
    }

    // Create mapping of section -> next section's first index
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

    return { nextInSection, prevInSection, firstOfNextSectionForIndex };
}

/**
 * Find the first word index of a given sentence
 */
export function findFirstWordOfSentence(words: WordItem[], sentenceIndex: number): number {
    for (let i = 0; i < words.length; i++) {
        if (words[i].sentenceIndex === sentenceIndex) {
            return i;
        }
    }
    return -1;
}

/**
 * Find the next sentence index from current word
 */
export function findNextSentence(words: WordItem[], currentWordIndex: number): number {
    if (currentWordIndex < 0 || currentWordIndex >= words.length) return -1;

    const currentSentence = words[currentWordIndex].sentenceIndex;

    // Find the next sentence
    for (let i = currentWordIndex + 1; i < words.length; i++) {
        if (words[i].sentenceIndex > currentSentence) {
            return i;
        }
    }

    return -1;
}

/**
 * Find the previous sentence index from current word
 */
export function findPrevSentence(words: WordItem[], currentWordIndex: number): number {
    if (currentWordIndex < 0 || currentWordIndex >= words.length) return -1;

    const currentSentence = words[currentWordIndex].sentenceIndex;

    // Find the previous sentence
    for (let i = currentWordIndex - 1; i >= 0; i--) {
        if (words[i].sentenceIndex < currentSentence) {
            // Find the first word of this sentence
            return findFirstWordOfSentence(words, words[i].sentenceIndex);
        }
    }

    return -1;
}
