export type TimeMS = number;

export interface SourceClip {
  id: string;
  filePath: string;
  proxyPath?: string;
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
  fadeIn?: FadeRange;
  fadeOut?: FadeRange;
}

export interface FadeRange {
  enabled: boolean;
  startMs: TimeMS;
  endMs: TimeMS;
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

export type SerializableClip = Omit<SourceClip, 'objectUrl'>;

export interface SavedProject {
  version: number;
  projectName: string;
  clips: SerializableClip[];
  tracks: TimelineTrack[];
  beatGrid: BeatGrid;
  waveform: number[];
  introSkipFrames: number;
  duration: TimeMS;
  zoom: number;
  useProxies: boolean;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: TimeMS; // Current playhead position in ms
  playbackRate: number;
}
