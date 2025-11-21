import React from 'react';
import { HighlightStyle } from '../../types';

interface StyleMenuProps {
    isOpen: boolean;
    onClose: () => void;
    readingHighlightColor: string;
    setReadingHighlightColor: (color: string) => void;
    readingHighlightStyle: HighlightStyle;
    setReadingHighlightStyle: (style: HighlightStyle) => void;
}

const AVAILABLE_COLORS = [
    { label: 'Yellow', value: '#facc5a' },
    { label: 'Green', value: '#7dc868' },
    { label: 'Blue', value: '#5c9aff' },
    { label: 'Red', value: '#ff6b6b' },
    { label: 'Purple', value: '#c885da' },
];

export function StyleMenu({
    isOpen,
    readingHighlightColor,
    setReadingHighlightColor,
    readingHighlightStyle,
    setReadingHighlightStyle,
}: StyleMenuProps) {
    if (!isOpen) return null;

    return (
        <div className="absolute bottom-16 right-0 bg-white p-4 rounded-lg shadow-xl border border-gray-200 w-64 mb-2">
            <h3 className="font-bold text-gray-700 mb-3">Highlight Styles</h3>

            <div className="mb-4">
                <label className="block text-sm font-medium text-gray-600 mb-1">Reading Highlight</label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {AVAILABLE_COLORS.map((color) => (
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
                        className={`px-3 py-1 text-xs rounded border ${readingHighlightStyle === 'highlight'
                                ? 'bg-blue-100 border-blue-500 text-blue-700'
                                : 'bg-white border-gray-300 text-gray-600'
                            }`}
                    >
                        Highlight
                    </button>
                    <button
                        onClick={() => setReadingHighlightStyle('underline')}
                        className={`px-3 py-1 text-xs rounded border ${readingHighlightStyle === 'underline'
                                ? 'bg-blue-100 border-blue-500 text-blue-700'
                                : 'bg-white border-gray-300 text-gray-600'
                            }`}
                    >
                        Underline
                    </button>
                </div>
            </div>

            <div className="text-xs text-gray-400 pt-2 border-t">
                Customize the style for your reading progress.
            </div>
        </div>
    );
}
