import React, { useRef, useMemo, useEffect } from 'react';
import { TimelineTrack, PlaybackState, BeatGrid, SourceClip, FadeRange } from '../types';
import { TRACK_HEIGHT, TIMELINE_ZOOM_MIN, TIMELINE_ZOOM_MAX } from '../constants';

interface TimelineProps {
    tracks: TimelineTrack[];
    clips: SourceClip[];
    playbackState: PlaybackState;
    beatGrid: BeatGrid;
    waveform: number[];
    zoom: number;
    duration: number;
    onSeek: (time: number) => void;
    onZoomChange: (zoom: number) => void;
    onSelectSegment: (id: string) => void;
    selectedSegmentId: string | null;
}

const Timeline: React.FC<TimelineProps> = ({
    tracks,
    clips,
    playbackState,
    beatGrid,
    waveform,
    zoom,
    duration,
    onSeek,
    onZoomChange,
    onSelectSegment,
    selectedSegmentId
}) => {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const isScrubbingRef = useRef(false);
    const defaultFadeIn = { enabled: false, startMs: 0, endMs: 500 };
    const defaultFadeOut = { enabled: false, startMs: -500, endMs: 0 };

    const clamp = (value: number, min: number, max: number) =>
        Math.min(max, Math.max(min, value));

    const getFadePixels = (fade: FadeRange, durationMs: number, isFadeOut: boolean) => {
        if (!fade.enabled) return null;
        const startRaw = isFadeOut ? durationMs + fade.startMs : fade.startMs;
        const endRaw = isFadeOut ? durationMs + fade.endMs : fade.endMs;
        const start = clamp(startRaw, 0, durationMs);
        const end = clamp(endRaw, 0, durationMs);
        const minEdge = Math.min(start, end);
        const maxEdge = Math.max(start, end);
        const lengthMs = maxEdge - minEdge;
        if (lengthMs <= 0) return null;
        return {
            leftPx: (minEdge / 1000) * zoom,
            widthPx: (lengthMs / 1000) * zoom
        };
    };

    const rulerHeight = 32;
    const timelineHeight = rulerHeight + tracks.length * TRACK_HEIGHT;
    // Calculate width based on total duration
    const totalWidth = (duration / 1000) * zoom;
    const clipNameById = useMemo(
        () => new Map(clips.map((clip) => [clip.id, clip.name])),
        [clips]
    );

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

    const handleWheel = (e: React.WheelEvent) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const container = scrollContainerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const cursorOffsetX = e.clientX - rect.left;
        const cursorTimeMs = ((cursorOffsetX + container.scrollLeft) / zoom) * 1000;
        const zoomDirection = e.deltaY > 0 ? 0.9 : 1.1;
        const nextZoom = clamp(zoom * zoomDirection, TIMELINE_ZOOM_MIN, TIMELINE_ZOOM_MAX);
        const nextScrollLeft = (cursorTimeMs / 1000) * nextZoom - cursorOffsetX;
        onZoomChange(nextZoom);
        requestAnimationFrame(() => {
            const nextContainer = scrollContainerRef.current;
            if (!nextContainer) return;
            const maxLeft = nextContainer.scrollWidth - nextContainer.clientWidth;
            nextContainer.scrollLeft = Math.max(0, Math.min(maxLeft, nextScrollLeft));
        });
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
            className="flex-none bg-stone-900 overflow-x-auto overflow-y-hidden relative select-none custom-scrollbar border-t border-stone-800 flex flex-col min-w-0"
            style={{ height: `${timelineHeight}px` }}
            onWheel={handleWheel}
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
                className="relative"
                style={{ width: `${Math.max(totalWidth, window.innerWidth)}px`, height: `${tracks.length * TRACK_HEIGHT}px` }}
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
                            const clipName = clipNameById.get(seg.sourceClipId) ?? 'Untitled clip';
                            const fadeIn = seg.fadeIn ?? defaultFadeIn;
                            const fadeOut = seg.fadeOut ?? defaultFadeOut;
                            const fadeInPx = getFadePixels(fadeIn, seg.duration, false);
                            const fadeOutPx = getFadePixels(fadeOut, seg.duration, true);
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
                                {fadeInPx && (
                                    <div
                                        className="absolute top-0 bottom-0 bg-gradient-to-r from-black/50 to-transparent pointer-events-none"
                                        style={{ left: `${fadeInPx.leftPx}px`, width: `${fadeInPx.widthPx}px` }}
                                    />
                                )}
                                {fadeOutPx && (
                                    <div
                                        className="absolute top-0 bottom-0 bg-gradient-to-l from-black/50 to-transparent pointer-events-none"
                                        style={{ left: `${fadeOutPx.leftPx}px`, width: `${fadeOutPx.widthPx}px` }}
                                    />
                                )}
                                <div className="absolute inset-x-2 top-1 flex flex-col gap-0.5 text-[10px] font-medium leading-tight pointer-events-none">
                                    <span className={`truncate drop-shadow ${isAudioTrack ? 'text-blue-100/90' : 'text-amber-100/90'}`}>
                                        {clipName}
                                    </span>
                                    {!isAudioTrack && (
                                        <span className="text-[9px] text-amber-200/70">
                                            {(seg.duration / 1000).toFixed(2)}s
                                        </span>
                                    )}
                                </div>
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
