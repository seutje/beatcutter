import React from 'react';
import { ClipSegment, SourceClip } from '../types';

interface InspectorProps {
    selectedSegmentId: string | null;
    segments: ClipSegment[];
    clips: SourceClip[];
    onUpdateSegment: (id: string, updates: Partial<ClipSegment>) => void;
}

const Inspector: React.FC<InspectorProps> = ({ selectedSegmentId, segments, clips, onUpdateSegment }) => {
    const segment = segments.find(s => s.id === selectedSegmentId);
    const sourceClip = segment ? clips.find(c => c.id === segment.sourceClipId) : null;

    if (!segment || !sourceClip) {
        return (
            <div className="w-[300px] bg-gray-900 border-l border-gray-800 p-6 flex flex-col items-center justify-center text-gray-600">
                <p>Select a clip on the timeline to inspect.</p>
            </div>
        );
    }

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
                    </div>
                </div>

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
            </div>
        </div>
    );
};

export default Inspector;