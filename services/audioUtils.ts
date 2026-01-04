import { BeatGrid } from '../types';

/**
 * Decodes an audio file and returns the AudioBuffer
 */
export const decodeAudio = async (file: File): Promise<AudioBuffer> => {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  return await audioContext.decodeAudioData(arrayBuffer);
};

/**
 * Simplified Beat Detection Algorithm
 * Based on energy thresholds in local windows.
 */
export const analyzeBeats = (buffer: AudioBuffer): BeatGrid => {
  const channelData = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  
  // 1. Break into windows (e.g., 20ms) and calculate RMS
  const windowSize = Math.floor(sampleRate * 0.05); // 50ms window
  
  // Calculate RMS for windows
  const volumeArray: number[] = [];
  for (let i = 0; i < channelData.length; i += windowSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      if (i + j < channelData.length) {
        sum += channelData[i + j] * channelData[i + j];
      }
    }
    const rms = Math.sqrt(sum / windowSize);
    volumeArray.push(rms);
  }

  // 2. Simple thresholding for peaks (Very basic onset detection)
  // Lowered threshold to detect quieter intros
  const threshold = 0.05; 
  const beatIndices: number[] = [];
  
  // Local average to detect spikes relative to background
  for (let i = 1; i < volumeArray.length - 1; i++) {
    const localAvg = (volumeArray[i - 1] + volumeArray[i] + volumeArray[i + 1]) / 3;
    if (volumeArray[i] > localAvg * 1.3 && volumeArray[i] > threshold) {
        // Debounce: ensure we don't pick multiple peaks too close
        if (beatIndices.length === 0 || (i - beatIndices[beatIndices.length - 1]) > 5) {
             beatIndices.push(i);
        }
    }
  }

  // Convert window indices back to seconds
  const beatTimes = beatIndices.map(idx => (idx * windowSize) / sampleRate);

  // 3. Estimate BPM (Naive Interval Histogram)
  let bpm = 120; // Default fallback
  if (beatTimes.length > 1) {
    const intervals: number[] = [];
    for (let i = 1; i < beatTimes.length; i++) {
      const interval = beatTimes[i] - beatTimes[i - 1];
      if (interval > 0.3 && interval < 1.0) { // Limit to 60-200 BPM range approx
        intervals.push(interval);
      }
    }
    
    // Sort and find median interval
    intervals.sort((a, b) => a - b);
    if (intervals.length > 0) {
        const medianInterval = intervals[Math.floor(intervals.length / 2)];
        bpm = Math.round(60 / medianInterval);
    }
  }

  // Refine BPM to standard ranges if it's weird
  if (bpm < 60) bpm *= 2;
  if (bpm > 180) bpm /= 2;

  // Generate a clean grid based on the estimated BPM
  // Find the first detected beat to use as an anchor
  const anchorBeat = beatTimes.length > 0 ? beatTimes[0] : 0;
  const { beats: uniqueBeats } = buildBeatGrid(bpm, anchorBeat, buffer.duration);

  return {
    bpm,
    offset: anchorBeat,
    beats: uniqueBeats,
  };
};

export const buildBeatGrid = (bpm: number, offset: number, durationSec: number): BeatGrid => {
  const cleanBeats: number[] = [];
  const spb = 60 / bpm;

  // Backfill beats to 0 (or slightly before)
  let t = offset;
  while (t > 0) {
    t -= spb;
  }

  // Forward fill
  while (t < durationSec) {
    if (t >= -0.1) {
      cleanBeats.push(Math.max(0, t));
    }
    t += spb;
  }

  const uniqueBeats = [...new Set(cleanBeats)];
  uniqueBeats.sort((a, b) => a - b);

  return {
    bpm,
    offset,
    beats: uniqueBeats,
  };
};

/**
 * Generate a simplified waveform data array for visualization
 */
export const generateWaveform = (buffer: AudioBuffer, points: number): number[] => {
    const channelData = buffer.getChannelData(0);
    const step = Math.ceil(channelData.length / points);
    const waveform: number[] = [];
    
    for (let i = 0; i < points; i++) {
        const start = i * step;
        let max = 0;
        // Optimization: don't check every sample, check a subset
        for (let j = 0; j < step; j+=100) {
            if (start + j < channelData.length) {
                const val = Math.abs(channelData[start + j]);
                if (val > max) max = val;
            }
        }
        waveform.push(max);
    }
    return waveform;
};
