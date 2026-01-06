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
    const playerARef = useRef<HTMLVideoElement>(null);
    const playerBRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderLoopRef = useRef<number>(0);
    
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
        const offsetInSegment = currentTime - currentSegment.timelineStart;
        const availableDuration = Math.max(0, sourceClip.duration - currentSegment.sourceStartOffset);
        const needsStretch = availableDuration > 0 && currentSegment.duration > availableDuration;
        const stretchRate = needsStretch ? availableDuration / currentSegment.duration : 1;
        const targetSourceTime = (currentSegment.sourceStartOffset + offsetInSegment * stretchRate) / 1000;

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

            if (playbackState.isPlaying) {
                if (player.playbackRate !== stretchRate) {
                    player.playbackRate = stretchRate;
                }
                // Ensure playing
                if (player.paused) {
                    player.play().catch(e => console.warn("Auto-play prevented or error:", e));
                }
            } else {
                if (player.playbackRate !== stretchRate) {
                    player.playbackRate = stretchRate;
                }
                if (!player.paused) player.pause();
            }
        }

    }, [playbackState.currentTime, playbackState.isPlaying, videoTrack, clips, getClipUrl]);


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
                         ctx.drawImage(player, 0, 0, canvas.width, canvas.height);
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
        <div className="w-full h-full bg-stone-950 flex items-center justify-center relative overflow-hidden">
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
