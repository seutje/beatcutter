import React from 'react';
import { Play, Pause, Download, Wand2 } from 'lucide-react';
import { PlaybackState } from '../types';

interface HeaderProps {
    playbackState: PlaybackState;
    onTogglePlay: () => void;
    onExport: () => void;
    onAutoSync: () => void;
    canSync: boolean;
    projectName: string;
}

const Header: React.FC<HeaderProps> = ({ 
    playbackState, 
    onTogglePlay, 
    onExport, 
    onAutoSync,
    canSync,
    projectName 
}) => {
    return (
        <header className="h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6 select-none">
            <div className="flex items-center gap-4">
                <div className="text-xl font-bold bg-gradient-to-r from-blue-500 to-indigo-500 bg-clip-text text-transparent">
                    BeatCutter
                </div>
                <span className="text-gray-500 text-sm">{projectName}</span>
            </div>

            <div className="flex items-center gap-4">
                 <button 
                    onClick={onAutoSync}
                    disabled={!canSync}
                    className={`flex items-center gap-2 px-4 py-2 rounded font-medium transition-colors ${
                        canSync 
                        ? 'bg-indigo-600 hover:bg-indigo-500 text-white' 
                        : 'bg-gray-800 text-gray-500 cursor-not-allowed'
                    }`}
                >
                    <Wand2 size={16} />
                    Auto-Sync
                </button>

                <div className="h-8 w-px bg-gray-700 mx-2"></div>

                <button 
                    onClick={onTogglePlay}
                    className="p-3 bg-gray-800 hover:bg-gray-700 rounded-full text-white transition-colors"
                >
                    {playbackState.isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                </button>

                <div className="text-mono text-gray-300 w-24 text-center">
                    {(playbackState.currentTime / 1000).toFixed(2)}s
                </div>

                <div className="h-8 w-px bg-gray-700 mx-2"></div>

                <button 
                    onClick={onExport}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium transition-colors"
                >
                    <Download size={16} />
                    Export FFmpeg
                </button>
            </div>
        </header>
    );
};

export default Header;