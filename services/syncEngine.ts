import { BeatGrid, ClipSegment, SourceClip } from '../types';
import { BEATS_PER_BAR } from '../constants';
import { v4 as uuidv4 } from 'uuid';

export const autoSyncClips = (
    clips: SourceClip[], 
    beatGrid: BeatGrid, 
    totalDuration: number,
    preferredBars: number = 4
): ClipSegment[] => {
    const beatsPerBar = BEATS_PER_BAR;
    const sanitizedBars = Number.isFinite(preferredBars) ? Math.max(1, Math.round(preferredBars)) : 4;
    const fallbackBars = [4, 2, 1].filter((bars) => bars < sanitizedBars);
    const allowedBarLengths = Array.from(new Set([sanitizedBars, ...fallbackBars]))
        .map((bars) => bars * beatsPerBar);
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
        // Clip to preferred, 4, 2, or 1 bars (no 3-bar segments).
        let chosenEndBeatIndex = -1;
        for (const beatLength of allowedBarLengths) {
            const candidateIndex = beatIndex + beatLength;
            if (candidateIndex < beats.length) {
                chosenEndBeatIndex = candidateIndex;
                break;
            }
        }
        if (chosenEndBeatIndex < 0) {
            const fallbackIndex = beatIndex + beatsPerBar;
            if (fallbackIndex >= beats.length) break;
            chosenEndBeatIndex = fallbackIndex;
        }

        const endTime = beats[chosenEndBeatIndex] * 1000;
        const duration = endTime - startTime;

        // Skip really short glitches
        if (duration < 100) {
            beatIndex += 1;
            continue;
        }

        // Default clip offset to 0 so segments start at the beginning.
        const sourceStartOffset = 0;

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
