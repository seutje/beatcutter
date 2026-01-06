import React from 'react';
import { Play, Pause, Download, Wand2, SkipBack, Settings } from 'lucide-react';
import { PlaybackState } from '../types';

interface HeaderProps {
    playbackState: PlaybackState;
    onTogglePlay: () => void;
    onJumpToStart: () => void;
    onExport: () => void;
    onAutoSync: () => void;
    canSync: boolean;
    canOpenAutoSync: boolean;
    useProxies: boolean;
    canToggleProxies: boolean;
    onToggleProxies: () => void;
    optionsOpen: boolean;
    onToggleOptions: () => void;
    geminiApiKey: string;
    onGeminiApiKeyChange: (value: string) => void;
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
    useProxies,
    canToggleProxies,
    onToggleProxies,
    optionsOpen,
    onToggleOptions,
    geminiApiKey,
    onGeminiApiKeyChange,
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

                <div className="relative flex items-center gap-2">
                    <button 
                        onClick={onExport}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded font-medium transition-colors"
                    >
                        <Download size={16} />
                        Export
                    </button>
                    <button
                        onClick={onToggleOptions}
                        aria-label="Options"
                        aria-expanded={optionsOpen}
                        aria-controls="header-options-panel"
                        className={`p-2.5 rounded border transition-colors ${
                            optionsOpen
                                ? 'bg-stone-700 border-stone-500 text-stone-100'
                                : 'bg-stone-800 border-stone-700 text-stone-200 hover:bg-stone-700'
                        }`}
                    >
                        <Settings size={16} />
                    </button>
                    {optionsOpen && (
                        <div
                            id="header-options-panel"
                            className="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-stone-800 bg-stone-900 p-4 shadow-xl"
                            role="dialog"
                            aria-label="Options"
                        >
                            <div className="text-xs uppercase tracking-wide text-stone-500">Options</div>
                            <label className="mt-3 block text-xs uppercase tracking-wide text-stone-500">
                                Gemini API Key
                                <input
                                    type="password"
                                    value={geminiApiKey}
                                    onChange={(e) => onGeminiApiKeyChange(e.target.value)}
                                    placeholder="Enter your key"
                                    className="mt-2 w-full rounded border border-stone-700 bg-stone-800 px-3 py-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-amber-400 focus:outline-none"
                                />
                            </label>
                            <p className="mt-2 text-xs text-stone-500">
                                Stored only for this session.
                            </p>
                            <button
                                onClick={onToggleProxies}
                                disabled={!canToggleProxies}
                                className={`mt-3 flex w-full items-center justify-between gap-2 rounded border px-3 py-2 text-sm font-medium transition-colors ${
                                    canToggleProxies
                                        ? useProxies
                                            ? 'bg-emerald-500/20 text-emerald-100 border-emerald-400/40 hover:bg-emerald-500/30'
                                            : 'bg-stone-800 text-stone-200 border-stone-700 hover:bg-stone-700'
                                        : 'bg-stone-800 text-stone-500 border-stone-700 cursor-not-allowed'
                                }`}
                                title={canToggleProxies ? 'Toggle proxies for preview playback' : 'Proxies available only in Electron'}
                            >
                                <span>Preview Proxies</span>
                                <span>{useProxies ? 'On' : 'Off'}</span>
                            </button>
                            <p className="mt-2 text-xs text-stone-500">
                                Uses lightweight proxy media during preview playback.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
};

export default Header;
