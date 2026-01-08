import React from 'react';
import { ClipSegment, FadeRange, SourceClip, TimelineTrack } from '../types';

interface InspectorProps {
    selectedSegmentId: string | null;
    tracks: TimelineTrack[];
    clips: SourceClip[];
    onUpdateSegment: (id: string, updates: Partial<ClipSegment>) => void;
    onRemoveSegment: (id: string) => void;
    swapMode: boolean;
    swapSourceId: string | null;
    onToggleSwapMode: (id: string) => void;
    introSkipFrames: number;
    onUpdateIntroSkipFrames: (frames: number) => void;
    bpm: number;
    barLengthSec: number;
    onUpdateBpm: (bpm: number) => void;
    onUpdateBarLength: (barLengthSec: number) => void;
}

const Inspector: React.FC<InspectorProps> = ({
    selectedSegmentId,
    tracks,
    clips,
    onUpdateSegment,
    onRemoveSegment,
    swapMode,
    swapSourceId,
    onToggleSwapMode,
    introSkipFrames,
    onUpdateIntroSkipFrames,
    bpm,
    barLengthSec,
    onUpdateBpm,
    onUpdateBarLength
}) => {
    const segment = tracks.flatMap(track => track.segments).find(s => s.id === selectedSegmentId);
    const sourceClip = segment ? clips.find(c => c.id === segment.sourceClipId) : null;
    const defaultFadeIn = { enabled: false, startMs: 0, endMs: 500 };
    const defaultFadeOut = { enabled: false, startMs: -500, endMs: 0 };

    if (!segment || !sourceClip) {
        return (
            <div className="w-[300px] bg-stone-900 border-l border-stone-800 p-6 flex flex-col items-center justify-center text-stone-500">
                <p>Select a clip on the timeline to inspect.</p>
            </div>
        );
    }

    const barDurationMs = Number.isFinite(barLengthSec) ? barLengthSec * 1000 : 0;
    const durationBars = barDurationMs > 0 ? segment.duration / barDurationMs : 0;
    const fadeIn = segment.fadeIn ?? defaultFadeIn;
    const fadeOut = segment.fadeOut ?? defaultFadeOut;
    const formatSec = (ms: number, fallback: number) =>
        Number.isFinite(ms) ? Number((ms / 1000).toFixed(2)) : fallback;
    const updateFade = (key: 'fadeIn' | 'fadeOut', updates: Partial<FadeRange>) => {
        const current = key === 'fadeIn' ? fadeIn : fadeOut;
        onUpdateSegment(segment.id, { [key]: { ...current, ...updates } } as Partial<ClipSegment>);
    };
    const updateFadeTime = (key: 'fadeIn' | 'fadeOut', field: 'startMs' | 'endMs', valueSec: number) => {
        if (!Number.isFinite(valueSec)) return;
        updateFade(key, { [field]: valueSec * 1000 });
    };
    const updateDurationMs = (nextDurationMs: number) => {
        if (!Number.isFinite(nextDurationMs)) return;
        const minDuration = 1;
        const maxDuration = Math.max(minDuration, sourceClip.duration);
        const clampedDuration = Math.min(maxDuration, Math.max(minDuration, nextDurationMs));
        const maxOffset = Math.max(0, sourceClip.duration - clampedDuration);
        const clampedOffset = Math.min(segment.sourceStartOffset, maxOffset);
        onUpdateSegment(segment.id, {
            duration: clampedDuration,
            sourceStartOffset: clampedOffset
        });
    };

    return (
        <div className="w-[300px] bg-stone-900 border-l border-stone-800 flex flex-col h-full overflow-y-auto">
            <div className="p-4 border-b border-stone-800">
                 <h2 className="text-stone-400 text-sm font-semibold uppercase tracking-wider mb-1">Inspector</h2>
                 <h3 className="text-stone-100 font-medium truncate" title={sourceClip.name}>{sourceClip.name}</h3>
            </div>
            <div className="px-4 py-4 border-b border-stone-800 space-y-3">
                {swapMode && swapSourceId === segment.id && (
                    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        Swap mode active. Select another clip on the same track to swap.
                    </div>
                )}
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => onRemoveSegment(segment.id)}
                        className="flex-1 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-red-200 hover:bg-red-500/20"
                    >
                        Remove
                    </button>
                    <button
                        type="button"
                        onClick={() => onToggleSwapMode(segment.id)}
                        className={`flex-1 rounded border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                            swapMode && swapSourceId === segment.id
                                ? 'border-amber-400 bg-amber-500/20 text-amber-100 shadow-[0_0_10px_rgba(245,158,11,0.35)]'
                                : 'border-stone-700 bg-stone-800 text-stone-200 hover:bg-stone-700'
                        }`}
                    >
                        {swapMode && swapSourceId === segment.id ? 'Swap Active' : 'Swap'}
                    </button>
                </div>
            </div>

            <div className="p-4 space-y-6">
                <div>
                    <label className="block text-xs text-stone-500 mb-2 uppercase">Timing (ms)</label>
                    <div className="grid grid-cols-2 gap-3">
                         <div>
                            <span className="text-xs text-stone-400 block mb-1">Start</span>
                            <input 
                                type="number" 
                                value={Math.round(segment.timelineStart)}
                                disabled
                                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                            />
                         </div>
                         <div>
                            <span className="text-xs text-stone-400 block mb-1">Duration</span>
                            <input 
                                type="number" 
                                value={Math.round(segment.duration)}
                                min={1}
                                step={1}
                                onChange={(e) => updateDurationMs(Number(e.target.value))}
                                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                            />
                         </div>
                         <div>
                            <span className="text-xs text-stone-400 block mb-1">Duration (bars)</span>
                            <input
                                type="number"
                                min={0.25}
                                max={8}
                                step={0.25}
                                value={Number.isFinite(durationBars) ? Number(durationBars.toFixed(2)) : 1}
                                disabled={sourceClip.type === 'audio'}
                                onChange={(e) => {
                                    const nextBars = Number(e.target.value);
                                    if (!Number.isFinite(nextBars) || barDurationMs <= 0) return;
                                    const clampedBars = Math.min(8, Math.max(0.5, nextBars));
                                    updateDurationMs(clampedBars * barDurationMs);
                                }}
                                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 disabled:cursor-not-allowed disabled:opacity-50"
                            />
                         </div>
                    </div>
                </div>

                <div>
                    <label className="block text-xs text-stone-500 mb-2 uppercase">Fades (s)</label>
                    <div className="space-y-3">
                        <div className="rounded border border-stone-800 bg-stone-900/40 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-stone-300 uppercase tracking-wide">Fade In</span>
                                <input
                                    type="checkbox"
                                    checked={fadeIn.enabled}
                                    onChange={(e) => updateFade('fadeIn', { enabled: e.target.checked })}
                                    className="h-4 w-4 accent-amber-500"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="text-xs text-stone-400">
                                    Start
                                    <input
                                        type="number"
                                        step={0.01}
                                        value={formatSec(fadeIn.startMs, 0)}
                                        onChange={(e) => updateFadeTime('fadeIn', 'startMs', Number(e.target.value))}
                                        disabled={!fadeIn.enabled}
                                        className="mt-1 w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 disabled:opacity-50"
                                    />
                                </label>
                                <label className="text-xs text-stone-400">
                                    End
                                    <input
                                        type="number"
                                        step={0.01}
                                        value={formatSec(fadeIn.endMs, 0.5)}
                                        onChange={(e) => updateFadeTime('fadeIn', 'endMs', Number(e.target.value))}
                                        disabled={!fadeIn.enabled}
                                        className="mt-1 w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 disabled:opacity-50"
                                    />
                                </label>
                            </div>
                        </div>

                        <div className="rounded border border-stone-800 bg-stone-900/40 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-stone-300 uppercase tracking-wide">Fade Out</span>
                                <input
                                    type="checkbox"
                                    checked={fadeOut.enabled}
                                    onChange={(e) => updateFade('fadeOut', { enabled: e.target.checked })}
                                    className="h-4 w-4 accent-amber-500"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="text-xs text-stone-400">
                                    Start
                                    <input
                                        type="number"
                                        step={0.01}
                                        value={formatSec(fadeOut.startMs, -0.5)}
                                        onChange={(e) => updateFadeTime('fadeOut', 'startMs', Number(e.target.value))}
                                        disabled={!fadeOut.enabled}
                                        className="mt-1 w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 disabled:opacity-50"
                                    />
                                </label>
                                <label className="text-xs text-stone-400">
                                    End
                                    <input
                                        type="number"
                                        step={0.01}
                                        value={formatSec(fadeOut.endMs, 0)}
                                        onChange={(e) => updateFadeTime('fadeOut', 'endMs', Number(e.target.value))}
                                        disabled={!fadeOut.enabled}
                                        className="mt-1 w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200 disabled:opacity-50"
                                    />
                                </label>
                            </div>
                        </div>
                    </div>
                </div>

                {sourceClip.type === 'audio' && (
                    <div>
                        <label className="block text-xs text-stone-500 mb-2 uppercase">Tempo</label>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <span className="text-xs text-stone-400 block mb-1">BPM</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={300}
                                    step={1}
                                    value={Number.isFinite(bpm) ? Number(bpm.toFixed(1)) : 120}
                                    onChange={(e) => onUpdateBpm(Number(e.target.value))}
                                    className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                                />
                            </div>
                            <div>
                                <span className="text-xs text-stone-400 block mb-1">Bar (s)</span>
                                <input
                                    type="number"
                                    min={0.1}
                                    step={0.001}
                                    value={Number.isFinite(barLengthSec) ? Number(barLengthSec.toFixed(3)) : 2}
                                    onChange={(e) => onUpdateBarLength(Number(e.target.value))}
                                    className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                                />
                            </div>
                        </div>
                        <p className="text-xs text-stone-500 mt-2 leading-relaxed">
                            Editing either value recalculates the beat grid so clips stay in sync.
                        </p>
                    </div>
                )}

                {sourceClip.type === 'audio' && (
                    <div>
                        <label className="block text-xs text-stone-500 mb-2 uppercase">Intro skip</label>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => onUpdateIntroSkipFrames(introSkipFrames - 1)}
                                className="w-8 h-8 rounded bg-stone-800 border border-stone-700 text-stone-200 hover:bg-stone-700"
                            >
                                -
                            </button>
                            <input
                                type="number"
                                value={introSkipFrames}
                                onChange={(e) => onUpdateIntroSkipFrames(Number(e.target.value))}
                                className="w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                            />
                            <button
                                type="button"
                                onClick={() => onUpdateIntroSkipFrames(introSkipFrames + 1)}
                                className="w-8 h-8 rounded bg-stone-800 border border-stone-700 text-stone-200 hover:bg-stone-700"
                            >
                                +
                            </button>
                        </div>
                        <p className="text-xs text-stone-500 mt-2 leading-relaxed">
                            Adjust the beat grid so the first beat lands on the right frame.
                        </p>
                    </div>
                )}

                {sourceClip.type === 'video' && (
                    <div>
                        <label className="block text-xs text-stone-500 mb-2 uppercase">Slip (Source Offset)</label>
                        <div className="space-y-2">
                            <div className="flex justify-between text-xs text-stone-400">
                                <span>0s</span>
                                <span>{(sourceClip.duration / 1000).toFixed(1)}s</span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={sourceClip.duration - segment.duration}
                                value={segment.sourceStartOffset}
                                onChange={(e) => onUpdateSegment(segment.id, { sourceStartOffset: Number(e.target.value) })}
                                className="w-full h-1 bg-stone-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
                            />
                            <div className="text-right text-xs text-amber-400">
                                +{(segment.sourceStartOffset / 1000).toFixed(2)}s
                            </div>
                        </div>
                        <p className="text-xs text-stone-500 mt-2 leading-relaxed">
                            Adjusting the slider changes which part of the original video plays during this segment without moving it on the timeline.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Inspector;
