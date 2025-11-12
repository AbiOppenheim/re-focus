# Re:Focus

Re:Focus — The ultimate focused reader. Pinpoint navigation and permanent highlighting for PDFs.

Short and fast: jump between sentence/paragraph boundaries, accumulate transient highlights while you read, and create persistent annotations when you hold "S".

## Key features
- Section-aware navigation (left/right for words, up/down for sections)
- Accumulative highlights per section (yellow)
- Persistent annotations (green) when holding "S" while navigating
- Double-click to jump & mark words
- Smooth auto-centering of the current section

## Where to look in the code
- Main app: [`App`](App.tsx) — handles file loading, navigation, state for visited/annotated words.
- Page rendering & highlights: [`PdfPage`](components/PdfPage.tsx) — renders PDF pages, text parsing, and drawing highlights.
- Dev server / build: [vite.config.ts](vite.config.ts)
- Entry / HTML: [index.tsx](index.tsx), [index.html](index.html)
- Project metadata: [package.json](package.json)

## Quick start

Prerequisites: Node.js

1. Install dependencies:
   npm install

2. Run in development:
   npm run dev

3. Open your browser at the printed Vite URL (default http://localhost:3000).

## Controls & usage
- Drag & drop or click to load a PDF.
- ArrowRight / ArrowLeft: move forward/back within the current section (or across pages).
- ArrowDown / ArrowUp: jump to next/previous section (Up restarts the current section).
- Hold "S" while navigating to toggle annotate mode (persistent green annotations).
- Double-click a word (or an annotation) to jump directly and mark it.

## Notes & troubleshooting
- The app loads PDF.js from CDN at runtime; if the library is still loading you'll see a loader — wait a moment and retry.
- For large PDFs parsing may take a few seconds per page.
- If links/annotations don't respond, ensure your browser allows mixed content and no strict CSP blocks external scripts.

## Acknowledgements
Built with React, Tailwind CSS, and PDF.js.