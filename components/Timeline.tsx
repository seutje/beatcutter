import React, { useRef, useMemo } from 'react';
import { TimelineTrack, PlaybackState, BeatGrid } from '../types';
import { TRACK_HEIGHT, DEFAULT_ZOOM } from '../constants';

interface TimelineProps {
    tracks: TimelineTrack[];
    playbackState: PlaybackState;
    beatGrid: BeatGrid;
    zoom: number;
    duration: number;
    onSeek: (time: number) => void;
    onSelectSegment: (id: string) => void;
    selectedSegmentId: string | null;
}

const Timeline: React.FC<TimelineProps> = ({
    tracks,
    playbackState,
    beatGrid,
    zoom,
    duration,
    onSeek,
    onSelectSegment,
    selectedSegmentId
}) => {
    const containerRef = useRef<HTMLDivElement>(null);

    // Calculate width based on total duration
    const totalWidth = (duration / 1000) * zoom;

    const handleTimelineClick = (e: React.MouseEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const offsetX = e.clientX - rect.left + containerRef.current.scrollLeft;
        const timeMs = (offsetX / zoom) * 1000;
        onSeek(Math.max(0, timeMs));
    };

    // Render Beats Grid
    const beatsRender = useMemo(() => {
        return beatGrid.beats.map((beatTime, idx) => (
            <div 
                key={idx}
                className="absolute top-0 bottom-0 w-px bg-gray-700/50 pointer-events-none"
                style={{ left: `${beatTime * zoom}px` }}
            />
        ));
    }, [beatGrid, zoom]);

    return (
        <div className="flex-1 bg-gray-900 overflow-x-auto overflow-y-hidden relative select-none custom-scrollbar border-t border-gray-800 h-64 flex flex-col">
            {/* Time Ruler */}
            <div 
                className="h-8 bg-gray-800 border-b border-gray-700 sticky top-0 z-10 cursor-pointer"
                style={{ width: `${Math.max(totalWidth, window.innerWidth)}px` }}
                onClick={handleTimelineClick}
                ref={containerRef}
            >
                {/* Generate ticks every second */}
                {Array.from({ length: Math.ceil(duration / 1000) }).map((_, sec) => (
                     <div key={sec} className="absolute bottom-0 text-[10px] text-gray-500 pl-1 border-l border-gray-600 h-3" style={{ left: `${sec * zoom}px`}}>
                        {sec}s
                     </div>
                ))}
            </div>

            {/* Tracks Container */}
            <div className="relative flex-1" style={{ width: `${Math.max(totalWidth, window.innerWidth)}px` }} onClick={handleTimelineClick}>
                {beatsRender}

                {tracks.map((track) => (
                    <div 
                        key={track.id} 
                        className="relative border-b border-gray-800 w-full hover:bg-gray-800/30 transition-colors"
                        style={{ height: `${TRACK_HEIGHT}px` }}
                    >
                        {/* Track Label */}
                        <div className="absolute left-2 top-2 z-10 text-xs text-gray-500 font-bold uppercase pointer-events-none opacity-50 mix-blend-difference">
                            {track.type}
                        </div>

                        {/* Segments */}
                        {track.segments.map((seg) => (
                            <div
                                key={seg.id}
                                onClick={(e) => { e.stopPropagation(); onSelectSegment(seg.id); }}
                                className={`absolute top-2 bottom-2 rounded cursor-pointer overflow-hidden border transition-colors ${
                                    selectedSegmentId === seg.id 
                                    ? 'bg-indigo-500 border-indigo-300 shadow-lg shadow-indigo-500/20 z-10' 
                                    : 'bg-indigo-900/60 border-indigo-700 hover:bg-indigo-800/80 hover:border-indigo-500'
                                }`}
                                style={{
                                    left: `${(seg.timelineStart / 1000) * zoom}px`,
                                    width: `${(seg.duration / 1000) * zoom}px`
                                }}
                            >
                                <div className="p-1 text-[10px] text-indigo-100 truncate opacity-75">
                                    {(seg.duration / 1000).toFixed(2)}s
                                </div>
                            </div>
                        ))}
                    </div>
                ))}

                {/* Playhead */}
                <div 
                    className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                    style={{ 
                        left: `${(playbackState.currentTime / 1000) * zoom}px`,
                        transform: 'translateX(-50%)'
                    }}
                >
                    <div className="w-3 h-3 bg-red-500 rounded-full -ml-[5px] -mt-1.5 shadow-sm"></div>
                </div>
            </div>
        </div>
    );
};

export default Timeline;