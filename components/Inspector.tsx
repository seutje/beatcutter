import React from 'react';
import { ClipSegment, SourceClip, TimelineTrack } from '../types';

interface InspectorProps {
    selectedSegmentId: string | null;
    tracks: TimelineTrack[];
    clips: SourceClip[];
    onUpdateSegment: (id: string, updates: Partial<ClipSegment>) => void;
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
    introSkipFrames,
    onUpdateIntroSkipFrames,
    bpm,
    barLengthSec,
    onUpdateBpm,
    onUpdateBarLength
}) => {
    const segment = tracks.flatMap(track => track.segments).find(s => s.id === selectedSegmentId);
    const sourceClip = segment ? clips.find(c => c.id === segment.sourceClipId) : null;

    if (!segment || !sourceClip) {
        return (
            <div className="w-[300px] bg-gray-900 border-l border-gray-800 p-6 flex flex-col items-center justify-center text-gray-600">
                <p>Select a clip on the timeline to inspect.</p>
            </div>
        );
    }

    const barDurationMs = Number.isFinite(barLengthSec) ? barLengthSec * 1000 : 0;
    const durationBars = barDurationMs > 0 ? segment.duration / barDurationMs : 0;

    return (
        <div className="w-[300px] bg-gray-900 border-l border-gray-800 flex flex-col h-full overflow-y-auto">
            <div className="p-4 border-b border-gray-800">
                 <h2 className="text-gray-400 text-sm font-semibold uppercase tracking-wider mb-1">Inspector</h2>
                 <h3 className="text-white font-medium truncate" title={sourceClip.name}>{sourceClip.name}</h3>
            </div>

            <div className="p-4 space-y-6">
                <div>
                    <label className="block text-xs text-gray-500 mb-2 uppercase">Timing (ms)</label>
                    <div className="grid grid-cols-2 gap-3">
                         <div>
                            <span className="text-xs text-gray-400 block mb-1">Start</span>
                            <input 
                                type="number" 
                                value={Math.round(segment.timelineStart)}
                                disabled
                                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
                            />
                         </div>
                         <div>
                            <span className="text-xs text-gray-400 block mb-1">Duration</span>
                            <input 
                                type="number" 
                                value={Math.round(segment.duration)}
                                disabled
                                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
                            />
                         </div>
                         <div>
                            <span className="text-xs text-gray-400 block mb-1">Duration (bars)</span>
                            <input
                                type="number"
                                min={0.5}
                                max={8}
                                step={0.5}
                                value={Number.isFinite(durationBars) ? Number(durationBars.toFixed(2)) : 1}
                                onChange={(e) => {
                                    const nextBars = Number(e.target.value);
                                    if (!Number.isFinite(nextBars) || barDurationMs <= 0) return;
                                    const clampedBars = Math.min(8, Math.max(0.5, nextBars));
                                    const nextDuration = clampedBars * barDurationMs;
                                    const maxOffset = Math.max(0, sourceClip.duration);
                                    const clampedOffset = Math.min(segment.sourceStartOffset, maxOffset);
                                    onUpdateSegment(segment.id, {
                                        duration: nextDuration,
                                        sourceStartOffset: clampedOffset
                                    });
                                }}
                                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
                            />
                         </div>
                    </div>
                </div>

                {sourceClip.type === 'audio' && (
                    <div>
                        <label className="block text-xs text-gray-500 mb-2 uppercase">Tempo</label>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <span className="text-xs text-gray-400 block mb-1">BPM</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={300}
                                    step={1}
                                    value={Number.isFinite(bpm) ? Number(bpm.toFixed(1)) : 120}
                                    onChange={(e) => onUpdateBpm(Number(e.target.value))}
                                    className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
                                />
                            </div>
                            <div>
                                <span className="text-xs text-gray-400 block mb-1">Bar (s)</span>
                                <input
                                    type="number"
                                    min={0.1}
                                    step={0.001}
                                    value={Number.isFinite(barLengthSec) ? Number(barLengthSec.toFixed(3)) : 2}
                                    onChange={(e) => onUpdateBarLength(Number(e.target.value))}
                                    className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
                                />
                            </div>
                        </div>
                        <p className="text-xs text-gray-600 mt-2 leading-relaxed">
                            Editing either value recalculates the beat grid so clips stay in sync.
                        </p>
                    </div>
                )}

                {sourceClip.type === 'audio' && (
                    <div>
                        <label className="block text-xs text-gray-500 mb-2 uppercase">Intro skip</label>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => onUpdateIntroSkipFrames(introSkipFrames - 1)}
                                className="w-8 h-8 rounded bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700"
                            >
                                -
                            </button>
                            <input
                                type="number"
                                value={introSkipFrames}
                                onChange={(e) => onUpdateIntroSkipFrames(Number(e.target.value))}
                                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
                            />
                            <button
                                type="button"
                                onClick={() => onUpdateIntroSkipFrames(introSkipFrames + 1)}
                                className="w-8 h-8 rounded bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700"
                            >
                                +
                            </button>
                        </div>
                        <p className="text-xs text-gray-600 mt-2 leading-relaxed">
                            Adjust the beat grid so the first beat lands on the right frame.
                        </p>
                    </div>
                )}

                {sourceClip.type === 'video' && (
                    <div>
                        <label className="block text-xs text-gray-500 mb-2 uppercase">Slip (Source Offset)</label>
                        <div className="space-y-2">
                            <div className="flex justify-between text-xs text-gray-400">
                                <span>0s</span>
                                <span>{(sourceClip.duration / 1000).toFixed(1)}s</span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={sourceClip.duration - segment.duration}
                                value={segment.sourceStartOffset}
                                onChange={(e) => onUpdateSegment(segment.id, { sourceStartOffset: Number(e.target.value) })}
                                className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                            />
                            <div className="text-right text-xs text-indigo-400">
                                +{(segment.sourceStartOffset / 1000).toFixed(2)}s
                            </div>
                        </div>
                        <p className="text-xs text-gray-600 mt-2 leading-relaxed">
                            Adjusting the slider changes which part of the original video plays during this segment without moving it on the timeline.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Inspector;
