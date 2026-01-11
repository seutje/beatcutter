import React, { useEffect, useRef, useState } from 'react';
import { PlaybackState, TimelineTrack, SourceClip, ClipSegment } from '../types';

interface PreviewPlayerProps {
    playbackState: PlaybackState;
    videoTrack: TimelineTrack | undefined;
    clips: SourceClip[];
    getClipUrl?: (clip: SourceClip) => string;
}

const PreviewPlayer: React.FC<PreviewPlayerProps> = ({ playbackState, videoTrack, clips, getClipUrl }) => {
    // Dual buffer references
    const containerRef = useRef<HTMLDivElement>(null);
    const playerARef = useRef<HTMLVideoElement>(null);
    const playerBRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderLoopRef = useRef<number>(0);
    const timeRef = useRef<number>(0);
    const trackRef = useRef<TimelineTrack | undefined>(undefined);
    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
        timeRef.current = playbackState.currentTime;
    }, [playbackState.currentTime]);

    useEffect(() => {
        trackRef.current = videoTrack;
    }, [videoTrack]);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(Boolean(document.fullscreenElement));
        };

        document.addEventListener('fullscreenchange', handleFullscreenChange);
        handleFullscreenChange();

        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
        };
    }, []);

    const handleToggleFullscreen = () => {
        const container = containerRef.current;
        if (!container) return;

        if (document.fullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            }
            return;
        }

        if (container.requestFullscreen) {
            container.requestFullscreen().catch(() => {});
        }
    };

    
    // Sync Logic
    useEffect(() => {
        if (!videoTrack) return;

        const currentTime = playbackState.currentTime;

        // Find the segment that should be playing right now
        const currentSegment = videoTrack.segments.find(
            seg => currentTime >= seg.timelineStart && currentTime < seg.timelineStart + seg.duration
        );

        if (!currentSegment) {
            // Pause and clear underlying players if no segment
            if (playerARef.current) {
                if (!playerARef.current.paused) playerARef.current.pause();
                playerARef.current.removeAttribute('data-clip-id');
                playerARef.current.removeAttribute('data-clip-url');
                playerARef.current.removeAttribute('src');
                playerARef.current.load();
            }
            if (playerBRef.current) {
                if (!playerBRef.current.paused) playerBRef.current.pause();
                playerBRef.current.removeAttribute('data-clip-id');
                playerBRef.current.removeAttribute('data-clip-url');
                playerBRef.current.removeAttribute('src');
                playerBRef.current.load();
            }
            return;
        }

        const sourceClip = clips.find(c => c.id === currentSegment.sourceClipId);
        if (!sourceClip) return;
        const sourceUrl = getClipUrl ? getClipUrl(sourceClip) : sourceClip.objectUrl;

        // Calculate the seek time within the source file.
        // If the segment duration exceeds the remaining clip duration, slow playback to fit.
        const isReverse = Boolean(currentSegment.reverse);
        const offsetInSegment = Math.max(
            0,
            Math.min(currentSegment.duration, currentTime - currentSegment.timelineStart)
        );
        const requestedRate = typeof currentSegment.playbackRate === 'number' && Number.isFinite(currentSegment.playbackRate)
            ? Math.max(0.05, currentSegment.playbackRate)
            : 1;
        const availableDuration = Math.max(0, sourceClip.duration - currentSegment.sourceStartOffset);
        const maxRate = availableDuration > 0 && currentSegment.duration > 0
            ? availableDuration / currentSegment.duration
            : requestedRate;
        const effectiveRate = Math.min(requestedRate, maxRate);
        const effectiveOffset = isReverse ? currentSegment.duration - offsetInSegment : offsetInSegment;
        const targetSourceTime = (currentSegment.sourceStartOffset + effectiveOffset * effectiveRate) / 1000;

        const player = playerARef.current;
        
        if (player) {
            // Check if source changed
            const currentClipId = player.getAttribute('data-clip-id');
            const currentClipUrl = player.getAttribute('data-clip-url');
            
            if (currentClipId !== sourceClip.id || currentClipUrl !== sourceUrl) {
                player.src = sourceUrl;
                player.setAttribute('data-clip-id', sourceClip.id);
                player.setAttribute('data-clip-url', sourceUrl);
                player.load();
            }

            const seekToTarget = () => {
                if (!Number.isFinite(targetSourceTime)) return;
                const durationSec = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : null;
                const clampedTarget = durationSec ? Math.min(targetSourceTime, Math.max(0, durationSec - 0.05)) : targetSourceTime;
                const timeDiff = Math.abs(player.currentTime - clampedTarget);
                if (timeDiff > 0.2 || !playbackState.isPlaying) {
                    try {
                        player.currentTime = clampedTarget;
                    } catch (e) {
                        console.warn("Seek failed:", e);
                    }
                }
            };

            // Sync Time after metadata is available
            if (player.readyState >= 1) {
                seekToTarget();
            } else {
                player.onloadedmetadata = seekToTarget;
            }

            if (isReverse) {
                if (player.playbackRate !== 1) {
                    player.playbackRate = 1;
                }
                if (!player.paused) {
                    player.pause();
                }
            } else if (playbackState.isPlaying) {
                if (player.playbackRate !== effectiveRate) {
                    player.playbackRate = effectiveRate;
                }
                // Ensure playing
                if (player.paused) {
                    player.play().catch(e => console.warn("Auto-play prevented or error:", e));
                }
            } else {
                if (player.playbackRate !== effectiveRate) {
                    player.playbackRate = effectiveRate;
                }
                if (!player.paused) player.pause();
            }
        }

    }, [playbackState.currentTime, playbackState.isPlaying, videoTrack, clips, getClipUrl]);

    const getFadeAlpha = (segment: ClipSegment, localTimeMs: number) => {
        const defaultFadeIn = { enabled: false, startMs: 0, endMs: 500 };
        const defaultFadeOut = { enabled: false, startMs: -500, endMs: 0 };
        const fadeIn = segment.fadeIn ?? defaultFadeIn;
        const fadeOut = segment.fadeOut ?? defaultFadeOut;
        let alpha = 1;

        if (fadeIn.enabled) {
            const start = Math.max(0, fadeIn.startMs);
            const end = Math.max(start, fadeIn.endMs);
            if (end <= start) {
                alpha = localTimeMs >= end ? 1 : 0;
            } else if (localTimeMs <= start) {
                alpha = 0;
            } else if (localTimeMs >= end) {
                alpha = 1;
            } else {
                alpha = (localTimeMs - start) / (end - start);
            }
        }

        if (fadeOut.enabled) {
            const start = segment.duration + fadeOut.startMs;
            const end = segment.duration + fadeOut.endMs;
            const clampedStart = Math.max(0, Math.min(segment.duration, start));
            const clampedEnd = Math.max(0, Math.min(segment.duration, end));
            const minEdge = Math.min(clampedStart, clampedEnd);
            const maxEdge = Math.max(clampedStart, clampedEnd);
            if (maxEdge <= minEdge) {
                if (localTimeMs >= maxEdge) {
                    alpha = Math.min(alpha, 0);
                }
            } else if (localTimeMs <= minEdge) {
                alpha = Math.min(alpha, 1);
            } else if (localTimeMs >= maxEdge) {
                alpha = Math.min(alpha, 0);
            } else {
                const t = (localTimeMs - minEdge) / (maxEdge - minEdge);
                alpha = Math.min(alpha, 1 - t);
            }
        }

        return Math.max(0, Math.min(1, alpha));
    };

    // Independent Render Loop
    // This ensures the canvas is updated whenever the video has a new frame, 
    // regardless of React state updates or sync logic.
    useEffect(() => {
        const render = () => {
            const player = playerARef.current;
            const canvas = canvasRef.current;
            
            if (player && canvas) {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    // Check if we should clear (no active video logic could be added here if needed)
                    // For now, just draw the player if it has metadata
                    if (player.readyState >= 2) {
                         const track = trackRef.current;
                         const currentTime = timeRef.current;
                         let alpha = 1;
                         if (track) {
                             const segment = track.segments.find(
                                 seg => currentTime >= seg.timelineStart && currentTime < seg.timelineStart + seg.duration
                             );
                             if (segment) {
                                 alpha = getFadeAlpha(segment, currentTime - segment.timelineStart);
                             }
                         }
                         ctx.clearRect(0, 0, canvas.width, canvas.height);
                         ctx.globalAlpha = alpha;
                         ctx.drawImage(player, 0, 0, canvas.width, canvas.height);
                         ctx.globalAlpha = 1;
                    } else if (!player.getAttribute('data-clip-id')) {
                         // Clear if no video loaded
                         ctx.fillStyle = 'black';
                         ctx.fillRect(0, 0, canvas.width, canvas.height);
                    }
                }
            }
            renderLoopRef.current = requestAnimationFrame(render);
        };
        
        renderLoopRef.current = requestAnimationFrame(render);
        
        return () => {
            cancelAnimationFrame(renderLoopRef.current);
        };
    }, []);


    return (
        <div ref={containerRef} className="w-full h-full bg-stone-950 flex items-center justify-center relative overflow-hidden">
            <button
                type="button"
                onClick={handleToggleFullscreen}
                className="absolute top-2 right-2 z-30 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-xs font-semibold text-white shadow hover:bg-black/80"
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
                <svg
                    viewBox="0 0 20 20"
                    className="h-4 w-4"
                    aria-hidden="true"
                    focusable="false"
                    fill="currentColor"
                >
                    {isFullscreen ? (
                        <path d="M5 9V5h4v2H7v2H5zm6-4h4v4h-2V7h-2V5zm-6 6h2v2h2v2H5v-4zm8 0h2v4h-4v-2h2v-2z" />
                    ) : (
                        <path d="M5 5h4v2H7v2H5V5zm8 0h-4v2h2v2h2V5zM5 15h4v-2H7v-2H5v4zm8-4h-2v2h-2v2h4v-4z" />
                    )}
                </svg>
                <span className="hidden sm:inline">{isFullscreen ? 'Exit' : 'Full'}</span>
            </button>
            {/* The Output Canvas */}
            <canvas 
                ref={canvasRef} 
                width={1280} 
                height={720} 
                className="w-full h-full object-contain z-10"
            />

            {/* Hidden Player A - Using opacity-0 instead of hidden to ensure drawing works in all browsers */}
            <video 
                ref={playerARef}
                className="absolute top-0 left-0 w-1 h-1 opacity-0 pointer-events-none"
                muted // Muted because we only want the video track
                playsInline
            />
            
            {/* Hidden Player B (Reserved) */}
            <video 
                ref={playerBRef}
                className="absolute top-0 left-0 w-1 h-1 opacity-0 pointer-events-none"
                muted
                playsInline
            />

            {!videoTrack && (
                <div className="absolute inset-0 flex items-center justify-center text-stone-500 pointer-events-none z-20">
                    <span className="text-2xl font-bold">NO SIGNAL</span>
                </div>
            )}
        </div>
    );
};

export default PreviewPlayer;
