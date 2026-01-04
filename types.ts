export type TimeMS = number;

export interface SourceClip {
  id: string;
  fileHandle: File;
  duration: TimeMS;
  thumbnailUrl: string;
  name: string;
  type: 'video' | 'audio';
  objectUrl: string; // Helper for previewing without re-creating URLs
}

export interface ClipSegment {
  id: string;
  sourceClipId: string;
  // Timeline positioning
  timelineStart: TimeMS;
  duration: TimeMS;
  // Source content selection (The "Slip")
  sourceStartOffset: TimeMS;
}

export interface TimelineTrack {
  id: string;
  type: 'video' | 'audio';
  segments: ClipSegment[];
}

export interface BeatGrid {
  bpm: number;
  offset: number; // Time in sec to first beat
  beats: number[]; // Array of timestamps in seconds
}

export interface Project {
  id: string;
  bpm: number;
  clips: SourceClip[];
  timeline: TimelineTrack[];
  duration: TimeMS;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: TimeMS; // Current playhead position in ms
  playbackRate: number;
}