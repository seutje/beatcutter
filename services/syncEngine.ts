import { BeatGrid, ClipSegment, SourceClip } from '../types';
import { v4 as uuidv4 } from 'uuid';

export const autoSyncClips = (
    clips: SourceClip[], 
    beatGrid: BeatGrid, 
    totalDuration: number
): ClipSegment[] => {
    const segments: ClipSegment[] = [];
    const orderedClips = [...clips].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
    let segmentIndex = 0;
    
    if (orderedClips.length === 0 || beatGrid.beats.length === 0) return [];

    const beats = beatGrid.beats;
    // Ensure we cover the start if the first beat is offset
    if (beats[0] > 0) {
        // This logic simplifies; real logic might backfill
    }

    // Iterate through beat intervals
    for (let i = 0; i < beats.length - 1; i++) {
        const startTime = beats[i] * 1000; // Convert to ms
        const endTime = beats[i + 1] * 1000;
        const duration = endTime - startTime;

        // Skip really short glitches
        if (duration < 100) continue;

        const clip = orderedClips[segmentIndex % orderedClips.length];

        // Determine a valid source offset
        // We want a random chunk of the video that fits the duration
        const maxOffset = clip.duration - duration;
        
        // If clip is too short, we loop it or just take what we can (clamping)
        let sourceStartOffset = 0;
        if (maxOffset > 0) {
            sourceStartOffset = Math.random() * maxOffset;
        }

        segments.push({
            id: uuidv4(),
            sourceClipId: clip.id,
            timelineStart: startTime,
            duration: duration,
            sourceStartOffset: sourceStartOffset
        });
        segmentIndex += 1;

        // Stop if we exceed total duration of audio
        if (startTime > totalDuration) break;
    }

    return segments;
};
