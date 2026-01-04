import React, { useRef, useMemo, useEffect } from 'react';
import { TimelineTrack, PlaybackState, BeatGrid } from '../types';
import { TRACK_HEIGHT, DEFAULT_ZOOM } from '../constants';

interface TimelineProps {
    tracks: TimelineTrack[];
    playbackState: PlaybackState;
    beatGrid: BeatGrid;
    waveform: number[];
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
    waveform,
    zoom,
    duration,
    onSeek,
    onSelectSegment,
    selectedSegmentId
}) => {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const isScrubbingRef = useRef(false);

    // Calculate width based on total duration
    const totalWidth = (duration / 1000) * zoom;

    const handleTimelineClick = (e: React.MouseEvent) => {
        if (!scrollContainerRef.current) return;
        const rect = scrollContainerRef.current.getBoundingClientRect();
        const offsetX = e.clientX - rect.left + scrollContainerRef.current.scrollLeft;
        const timeMs = (offsetX / zoom) * 1000;
        onSeek(Math.max(0, Math.min(duration, timeMs)));
    };

    const updateTimeFromClientX = (clientX: number) => {
        if (!scrollContainerRef.current) return;
        const rect = scrollContainerRef.current.getBoundingClientRect();
        const offsetX = clientX - rect.left + scrollContainerRef.current.scrollLeft;
        const timeMs = (offsetX / zoom) * 1000;
        onSeek(Math.max(0, Math.min(duration, timeMs)));
    };

    const handleScrubStart = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        isScrubbingRef.current = true;
        updateTimeFromClientX(e.clientX);
        e.preventDefault();
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isScrubbingRef.current) return;
            updateTimeFromClientX(e.clientX);
        };
        const handleMouseUp = () => {
            if (!isScrubbingRef.current) return;
            isScrubbingRef.current = false;
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [zoom, duration, onSeek]);

    useEffect(() => {
        if (!playbackState.isPlaying) return;
        const container = scrollContainerRef.current;
        if (!container) return;
        const viewLeft = container.scrollLeft;
        const viewRight = viewLeft + container.clientWidth;
        const playheadX = (playbackState.currentTime / 1000) * zoom;

        if (playheadX > viewRight || playheadX < viewLeft) {
            const direction = playheadX > viewRight ? 1 : -1;
            const nextLeft = viewLeft + direction * container.clientWidth;
            const maxLeft = container.scrollWidth - container.clientWidth;
            container.scrollLeft = Math.max(0, Math.min(maxLeft, nextLeft));
        }
    }, [playbackState.currentTime, playbackState.isPlaying, zoom]);

    // Render Beats Grid
    const beatsRender = useMemo(() => {
        return beatGrid.beats.map((beatTime, idx) => (
            <div 
                key={idx}
                className="absolute top-0 bottom-0 w-px bg-blue-500/25 pointer-events-none"
                style={{ left: `${beatTime * zoom}px` }}
            />
        ));
    }, [beatGrid, zoom]);

    const waveformPath = useMemo(() => {
        if (waveform.length < 2) return '';
        const top = waveform.map((amp, idx) => `${idx} ${0.5 - amp * 0.48}`);
        const bottom = waveform
            .slice()
            .reverse()
            .map((amp, idx) => `${waveform.length - 1 - idx} ${0.5 + amp * 0.48}`);
        return `M ${top[0]} L ${top.join(' L ')} L ${bottom.join(' L ')} Z`;
    }, [waveform]);

    return (
        <div
            ref={scrollContainerRef}
            className="flex-1 bg-stone-900 overflow-x-auto overflow-y-hidden relative select-none custom-scrollbar border-t border-stone-800 h-64 flex flex-col min-w-0"
        >
            {/* Time Ruler */}
            <div 
                className="h-8 bg-stone-800 border-b border-stone-700 sticky top-0 z-10 cursor-pointer"
                style={{ width: `${Math.max(totalWidth, window.innerWidth)}px` }}
                onClick={handleTimelineClick}
                onMouseDown={handleScrubStart}
            >
                {/* Generate ticks every second */}
                {Array.from({ length: Math.ceil(duration / 1000) }).map((_, sec) => (
                     <div key={sec} className="absolute bottom-0 text-[10px] text-stone-500 pl-1 border-l border-stone-700 h-3" style={{ left: `${sec * zoom}px`}}>
                        {sec}s
                     </div>
                ))}
            </div>

            {/* Tracks Container */}
            <div
                className="relative flex-1"
                style={{ width: `${Math.max(totalWidth, window.innerWidth)}px` }}
                onClick={handleTimelineClick}
                onMouseDown={handleScrubStart}
            >
                {beatsRender}

                {tracks.map((track) => (
                    <div 
                        key={track.id} 
                        className="relative border-b border-stone-800 w-full hover:bg-stone-800/40 transition-colors"
                        style={{ height: `${TRACK_HEIGHT}px` }}
                    >
                        {/* Track Label */}
                        <div className="absolute left-2 top-2 z-10 text-xs text-stone-500 font-bold uppercase pointer-events-none opacity-50 mix-blend-difference">
                            {track.type}
                        </div>

                        {track.type === 'audio' && waveform.length > 1 && (
                            <div className="absolute inset-0 z-0 pointer-events-none">
                                <svg
                                    className="w-full h-full"
                                    viewBox={`0 0 ${waveform.length - 1} 1`}
                                    preserveAspectRatio="none"
                                >
                                    <path
                                        d={waveformPath}
                                        fill="rgba(37,99,235,0.2)"
                                        stroke="rgba(37,99,235,0.6)"
                                        strokeWidth="0.02"
                                    />
                                </svg>
                            </div>
                        )}

                        {track.type === 'audio' &&
                            beatGrid.beats.map((beatTime, idx) => (
                                <div
                                    key={idx}
                                    className="absolute top-1 bottom-1 w-px bg-blue-300/70 pointer-events-none shadow-[0_0_6px_rgba(37,99,235,0.6)]"
                                    style={{ left: `${beatTime * zoom}px` }}
                                />
                            ))}

                        {/* Segments */}
                        {track.segments.map((seg) => {
                            const isSelected = selectedSegmentId === seg.id;
                            const isAudioTrack = track.type === 'audio';
                            const baseClass = isAudioTrack
                                ? 'border-blue-300/70'
                                : isSelected
                                    ? 'bg-amber-500 border-amber-300 shadow-lg shadow-amber-500/20 z-20'
                                    : 'bg-amber-900/50 border-amber-700 hover:bg-amber-800/70 hover:border-amber-500 z-10';
                            const audioClass = isSelected
                                ? 'bg-blue-500/20 shadow-[0_0_10px_rgba(37,99,235,0.35)]'
                                : 'bg-blue-500/10 hover:bg-blue-500/15 z-10';
                            return (
                            <div
                                key={seg.id}
                                onClick={(e) => { e.stopPropagation(); onSelectSegment(seg.id); }}
                                onMouseDown={(e) => { e.stopPropagation(); }}
                                className={`absolute top-2 bottom-2 rounded cursor-pointer overflow-hidden border transition-colors ${
                                    isAudioTrack ? `${baseClass} ${audioClass}` : baseClass
                                }`}
                                style={{
                                    left: `${(seg.timelineStart / 1000) * zoom}px`,
                                    width: `${(seg.duration / 1000) * zoom}px`
                                }}
                            >
                                {!isAudioTrack && (
                                    <div className="p-1 text-[10px] text-amber-100 truncate opacity-75">
                                        {(seg.duration / 1000).toFixed(2)}s
                                    </div>
                                )}
                            </div>
                        )})}
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
