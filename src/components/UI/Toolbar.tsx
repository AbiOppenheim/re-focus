import React from 'react';

interface ToolbarProps {
    onDownload: () => void;
    isHighlightToolActive: boolean;
    onToggleHighlightTool: () => void;
    onToggleStyleMenu: () => void;
    hasDocument: boolean;
}

export function Toolbar({
    onDownload,
    isHighlightToolActive,
    onToggleHighlightTool,
    onToggleStyleMenu,
    hasDocument,
}: ToolbarProps) {
    if (!hasDocument) return null;

    return (
        <>
            {/* Download and Highlight Tool Buttons */}
            <div className="fixed bottom-8 right-8 flex flex-col gap-4 z-50">
                <button
                    onClick={onDownload}
                    className="bg-green-600 text-white p-4 rounded-full shadow-lg hover:bg-green-700 transition-colors flex items-center justify-center"
                    title="Download PDF with Highlights (D)"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                    </svg>
                </button>
                <button
                    onClick={onToggleHighlightTool}
                    className={`${isHighlightToolActive ? 'bg-yellow-500' : 'bg-blue-600'
                        } text-white p-4 rounded-full shadow-lg hover:opacity-90 transition-colors flex items-center justify-center`}
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
                    onClick={onToggleStyleMenu}
                    className="bg-indigo-600 text-white p-4 rounded-full shadow-lg hover:bg-indigo-700 transition-colors flex items-center justify-center"
                    title="Style Settings"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                    </svg>
                </button>
            </div>
        </>
    );
}
