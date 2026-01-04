import React from 'react';
import { Play, Pause, Download, Wand2, SkipBack } from 'lucide-react';
import { PlaybackState } from '../types';

interface HeaderProps {
    playbackState: PlaybackState;
    onTogglePlay: () => void;
    onJumpToStart: () => void;
    onExport: () => void;
    onAutoSync: () => void;
    canSync: boolean;
    canOpenAutoSync: boolean;
    projectName: string;
}

const Header: React.FC<HeaderProps> = ({ 
    playbackState, 
    onTogglePlay, 
    onJumpToStart,
    onExport, 
    onAutoSync,
    canSync,
    canOpenAutoSync,
    projectName 
}) => {
    return (
        <header className="h-16 bg-stone-900 border-b border-stone-800 flex items-center justify-between px-6 select-none">
            <div className="flex items-center gap-4">
                <div className="text-xl font-bold bg-gradient-to-r from-amber-300 to-rose-400 bg-clip-text text-transparent">
                    BeatCutter
                </div>
                <span className="text-stone-400 text-sm">{projectName}</span>
            </div>

            <div className="flex items-center gap-4">
                 <button 
                    onClick={onAutoSync}
                    disabled={!canOpenAutoSync}
                    className={`flex items-center gap-2 px-4 py-2 rounded font-medium transition-colors ${
                        canOpenAutoSync 
                        ? 'bg-amber-500 hover:bg-amber-400 text-stone-950' 
                        : 'bg-stone-800 text-stone-500 cursor-not-allowed'
                    }`}
                >
                    <Wand2 size={16} />
                    Auto-Sync
                </button>

                <div className="h-8 w-px bg-stone-700/80 mx-2"></div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={onJumpToStart}
                        className="p-3 bg-stone-800 hover:bg-stone-700 rounded-full text-stone-100 transition-colors"
                        aria-label="Back to start"
                        title="Back to start"
                    >
                        <SkipBack size={18} />
                    </button>
                    <button 
                        onClick={onTogglePlay}
                        className="p-3 bg-stone-800 hover:bg-stone-700 rounded-full text-stone-100 transition-colors"
                        aria-label={playbackState.isPlaying ? 'Pause' : 'Play'}
                        title={playbackState.isPlaying ? 'Pause' : 'Play'}
                    >
                        {playbackState.isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                    </button>
                </div>

                <div className="text-mono text-stone-300 w-24 text-center">
                    {(playbackState.currentTime / 1000).toFixed(2)}s
                </div>

                <div className="h-8 w-px bg-stone-700/80 mx-2"></div>

                <button 
                    onClick={onExport}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded font-medium transition-colors"
                >
                    <Download size={16} />
                    Export
                </button>
            </div>
        </header>
    );
};

export default Header;
