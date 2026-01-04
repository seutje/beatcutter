import React from 'react';
import { Upload, Music, Film, Trash2 } from 'lucide-react';
import { SourceClip } from '../types';

interface MediaPoolProps {
    clips: SourceClip[];
    onImport: (files: FileList) => void;
    onDelete: (id: string) => void;
}

const MediaPool: React.FC<MediaPoolProps> = ({ clips, onImport, onDelete }) => {
    
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onImport(e.target.files);
        }
        e.target.value = ''; // Reset
    };

    return (
        <div className="w-[300px] bg-gray-900 border-r border-gray-800 flex flex-col h-full">
            <div className="p-4 border-b border-gray-800">
                <h2 className="text-gray-400 text-sm font-semibold uppercase tracking-wider mb-3">Media Pool</h2>
                <label className="flex items-center justify-center w-full h-12 border-2 border-dashed border-gray-700 rounded-lg cursor-pointer hover:border-gray-500 hover:bg-gray-800 transition-all">
                    <div className="flex items-center gap-2 text-gray-400">
                        <Upload size={16} />
                        <span className="text-sm font-medium">Import Media</span>
                    </div>
                    <input type="file" className="hidden" multiple accept="video/*,audio/*" onChange={handleFileChange} />
                </label>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {clips.map(clip => (
                    <div key={clip.id} className="group flex gap-3 p-2 rounded bg-gray-800/50 hover:bg-gray-800 transition-colors cursor-pointer border border-transparent hover:border-gray-600">
                        <div className="w-16 h-16 bg-black rounded flex items-center justify-center overflow-hidden shrink-0 relative">
                             {clip.type === 'video' ? (
                                <video src={clip.objectUrl} className="w-full h-full object-cover pointer-events-none" />
                             ) : (
                                <Music className="text-gray-600" />
                             )}
                             <div className="absolute bottom-0 right-0 bg-black/80 text-[10px] text-white px-1">
                                {(clip.duration / 1000).toFixed(1)}s
                             </div>
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                            <div className="text-sm text-gray-200 truncate font-medium">{clip.name}</div>
                            <div className="text-xs text-gray-500 flex items-center gap-1">
                                {clip.type === 'video' ? <Film size={12} /> : <Music size={12} />}
                                {clip.type.toUpperCase()}
                            </div>
                        </div>
                        <button 
                            onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
                            className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-2"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                ))}

                {clips.length === 0 && (
                    <div className="text-center text-gray-600 mt-10 text-sm">
                        No media imported.<br/>Drag & drop or click Import.
                    </div>
                )}
            </div>
        </div>
    );
};

export default MediaPool;