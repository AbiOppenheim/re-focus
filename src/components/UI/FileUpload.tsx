import React, { useRef } from 'react';

interface FileUploadProps {
    onFileSelect: (file: File) => void;
}

export function FileUpload({ onFileSelect }: FileUploadProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && file.type === 'application/pdf') {
            onFileSelect(file);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && file.type === 'application/pdf') {
            onFileSelect(file);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const triggerFileSelect = () => fileInputRef.current?.click();

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

                <p className="mt-3 text-sm text-gray-500">
                    You can also press and hold "S" while double-clicking words to toggle annotation mode.
                </p>
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
}
