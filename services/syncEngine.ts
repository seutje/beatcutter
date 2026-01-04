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

    // Iterate through beat intervals, allowing clips to span multiple beats.
    let beatIndex = 0;
    while (beatIndex < beats.length - 1) {
        const startTime = beats[beatIndex] * 1000; // Convert to ms

        const clip = orderedClips[segmentIndex % orderedClips.length];
        const maxEndTime = startTime + clip.duration;

        // Find the last beat that fits within the clip length.
        let endBeatIndex = beatIndex + 1;
        while (endBeatIndex < beats.length && beats[endBeatIndex] * 1000 <= maxEndTime) {
            endBeatIndex += 1;
        }

        let chosenEndBeatIndex = endBeatIndex - 1;
        if (chosenEndBeatIndex <= beatIndex) {
            // If the clip is shorter than a single beat interval, fall back to the next beat.
            chosenEndBeatIndex = beatIndex + 1;
        }
        if (chosenEndBeatIndex >= beats.length) break;

        const endTime = beats[chosenEndBeatIndex] * 1000;
        const duration = endTime - startTime;

        // Skip really short glitches
        if (duration < 100) {
            beatIndex += 1;
            continue;
        }

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

        beatIndex = chosenEndBeatIndex;
    }

    return segments;
};
