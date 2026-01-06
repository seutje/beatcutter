import React, { useState, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Project, SourceClip, TimelineTrack, BeatGrid, PlaybackState, ClipSegment } from './types';
import { decodeAudio, analyzeBeats, buildBeatGrid, generateWaveform } from './services/audioUtils';
import { runFfmpeg, onFfmpegProgress } from './services/ffmpegBridge';
import { autoSyncClips } from './services/syncEngine';
import { DEFAULT_ZOOM, DEFAULT_FPS, BEATS_PER_BAR } from './constants';
import Header from './components/Header';
import MediaPool from './components/MediaPool';
import Timeline from './components/Timeline';
import Inspector from './components/Inspector';
import PreviewPlayer from './components/PreviewPlayer';

const App: React.FC = () => {
  // --- State ---
  const [clips, setClips] = useState<SourceClip[]>([]);
  const [tracks, setTracks] = useState<TimelineTrack[]>([
    { id: 'video-1', type: 'video', segments: [] },
    { id: 'audio-1', type: 'audio', segments: [] }
  ]);
  const [beatGrid, setBeatGrid] = useState<BeatGrid>({ bpm: 120, offset: 0, beats: [] });
  const [waveform, setWaveform] = useState<number[]>([]);
  const [introSkipFrames, setIntroSkipFrames] = useState<number>(0);
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    isPlaying: false,
    currentTime: 0,
    playbackRate: 1
  });
  const [duration, setDuration] = useState<number>(30000); // 30s default
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [swapMode, setSwapMode] = useState<boolean>(false);
  const [swapSourceId, setSwapSourceId] = useState<string | null>(null);
  const [autoSyncOpen, setAutoSyncOpen] = useState<boolean>(false);
  const [autoSyncBpm, setAutoSyncBpm] = useState<number>(120);
  const [autoSyncBars, setAutoSyncBars] = useState<number>(4);
  const [autoSyncIntroSkipFrames, setAutoSyncIntroSkipFrames] = useState<number>(0);
  const [autoSyncError, setAutoSyncError] = useState<string | null>(null);
  const [autoSyncAnalyzing, setAutoSyncAnalyzing] = useState<boolean>(false);
  const [exportOpen, setExportOpen] = useState<boolean>(false);
  const [exportResolution, setExportResolution] = useState<string>('1920x1080');
  const [exportMbps, setExportMbps] = useState<number>(12);
  const [exporting, setExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [exportError, setExportError] = useState<string | null>(null);

  // --- Refs for Audio Engine ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const scrubPreviewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const masterAudioBufferRef = useRef<AudioBuffer | null>(null);
  const startTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);

  // --- Handlers ---

  const toFileUrl = (filePath: string) => {
      if (
          filePath.startsWith('file://') ||
          filePath.startsWith('media://') ||
          filePath.startsWith('blob:') ||
          filePath.startsWith('data:')
      ) {
          return filePath;
      }
      if (window.electronAPI) {
          const normalized = filePath.replace(/\\/g, '/');
          if (/^[A-Za-z]:\//.test(normalized)) {
              return `media:///${encodeURI(normalized)}`;
          }
          const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
          return `media://${encodeURI(withLeadingSlash)}`;
      }
      const normalized = filePath.replace(/\\/g, '/');
      const prefix = normalized.startsWith('/') ? 'file://' : 'file:///';
      return `${prefix}${encodeURI(normalized)}`;
  };

  const getBaseName = (filePath: string) => filePath.split(/[\\/]/).pop() || 'Untitled';

  const getExtension = (filePath: string, fallbackName?: string) => {
      const base = filePath.startsWith('blob:') && fallbackName ? fallbackName : getBaseName(filePath);
      const idx = base.lastIndexOf('.');
      return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
  };

  const getPathSeparator = (filePath: string) => (filePath.includes('\\') ? '\\' : '/');

  const getDirName = (filePath: string) => {
      const sep = getPathSeparator(filePath);
      const idx = filePath.lastIndexOf(sep);
      if (idx === 0) return sep;
      if (idx < 0) return '.';
      return filePath.slice(0, idx);
  };

  const joinPath = (dir: string, fileName: string) => {
      const sep = getPathSeparator(dir);
      if (dir === sep) return `${sep}${fileName}`;
      if (dir.endsWith(sep)) return `${dir}${fileName}`;
      return `${dir}${sep}${fileName}`;
  };

  const isAudioPath = (filePath: string, fallbackName?: string) => {
      const audioExtensions = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus']);
      return audioExtensions.has(getExtension(filePath, fallbackName));
  };

  const getMimeType = (filePath: string, fallbackName?: string) => {
      const ext = getExtension(filePath, fallbackName);
      const mimeMap: Record<string, string> = {
          mp3: 'audio/mpeg',
          wav: 'audio/wav',
          flac: 'audio/flac',
          aac: 'audio/aac',
          m4a: 'audio/mp4',
          ogg: 'audio/ogg',
          opus: 'audio/opus',
          mp4: 'video/mp4',
          mov: 'video/quicktime',
          mkv: 'video/x-matroska',
          webm: 'video/webm',
          avi: 'video/x-msvideo'
      };
      return mimeMap[ext] || 'application/octet-stream';
  };

  const handleImport = async (fileList?: FileList) => {
    const newClips: SourceClip[] = [];
    const importClip = async (filePath: string, nameOverride?: string) => {
        const clipId = uuidv4();
        const isAudio = isAudioPath(filePath, nameOverride);
        const fileUrl = toFileUrl(filePath);
        const objectUrl = fileUrl;
        let duration = 0;

        try {
            if (isAudio) {
               duration = await new Promise<number>((resolve) => {
                   const audio = document.createElement('audio');
                   audio.preload = 'metadata';
                   audio.onloadedmetadata = () => resolve(audio.duration * 1000);
                   audio.onerror = () => resolve(0);
                   audio.src = objectUrl;
               });

               if (!masterAudioBufferRef.current && duration > 0) {
                 const buffer = await decodeAudio(fileUrl);
                 masterAudioBufferRef.current = buffer;
                 const analysis = analyzeBeats(buffer);
                 setBeatGrid(analysis);
                 setIntroSkipFrames(0);
                 const waveformPoints = Math.min(4000, Math.max(600, Math.floor(buffer.duration * 60)));
                 setWaveform(generateWaveform(buffer, waveformPoints));
                 setDuration(buffer.duration * 1000);

                 setTracks(prev => prev.map(t =>
                    t.type === 'audio' ? {
                        ...t,
                        segments: [{
                            id: uuidv4(),
                            sourceClipId: clipId,
                            timelineStart: 0,
                            duration: buffer.duration * 1000,
                            sourceStartOffset: 0
                        }]
                    } : t
                 ));
               }
            } else {
               duration = await new Promise<number>((resolve) => {
                   const video = document.createElement('video');
                   video.preload = 'metadata';
                   video.onloadedmetadata = () => resolve(video.duration * 1000);
                   video.onerror = () => resolve(0);
                   video.src = objectUrl;
               });
            }
        } catch (e) {
            console.error("Error loading metadata for", filePath, e);
        }

        newClips.push({
            id: clipId,
            filePath,
            duration: duration || 1000,
            thumbnailUrl: '',
            name: nameOverride ?? getBaseName(filePath),
            type: isAudio ? 'audio' : 'video',
            objectUrl
        });
    };

    if (fileList) {
        const files = Array.from(fileList);
        for (const file of files) {
            const objectUrl = URL.createObjectURL(file);
            await importClip(objectUrl, file.name);
        }
    } else if (window.electronAPI?.selectFiles) {
        const filePaths = await window.electronAPI.selectFiles();
        if (filePaths.length === 0) return;
        for (const filePath of filePaths) {
            await importClip(filePath);
        }
    } else {
        console.warn('File selection is only available in the Electron app.');
        return;
    }

    setClips(prev => [...prev, ...newClips]);
  };

  const handleDeleteClip = (id: string) => {
      setClips(prev => prev.filter(c => c.id !== id));
      // Remove segments from timeline that use this clip
      setTracks(prev => prev.map(t => ({
          ...t,
          segments: t.segments.filter(s => s.sourceClipId !== id)
      })));
  };

  const handleRemoveSegment = (id: string) => {
      setTracks(prev => prev.map(t => {
          const target = t.segments.find(s => s.id === id);
          if (!target) {
              return { ...t, segments: t.segments.filter(s => s.id !== id) };
          }
          const removedEnd = target.timelineStart + target.duration;
          const nextSegments = t.segments
              .filter(s => s.id !== id)
              .map(s => {
                  if (s.timelineStart >= removedEnd) {
                      return { ...s, timelineStart: s.timelineStart - target.duration };
                  }
                  return s;
              });
          return { ...t, segments: nextSegments };
      }));
      if (selectedSegmentId === id) {
          setSelectedSegmentId(null);
      }
      if (swapSourceId === id) {
          setSwapMode(false);
          setSwapSourceId(null);
      }
  };

  const clampOffsetForClip = (clipId: string, durationMs: number, offsetMs: number) => {
      const clip = clips.find(c => c.id === clipId);
      const maxOffset = clip ? Math.max(0, clip.duration - durationMs) : 0;
      return Math.min(Math.max(0, offsetMs), maxOffset);
  };

  const handleSwapSegments = (sourceId: string, targetId: string) => {
      setTracks(prev => {
          const sourceTrack = prev.find(t => t.segments.some(s => s.id === sourceId));
          const targetTrack = prev.find(t => t.segments.some(s => s.id === targetId));
          if (!sourceTrack || !targetTrack || sourceTrack.type !== targetTrack.type) {
              return prev;
          }

          const sourceSegment = sourceTrack.segments.find(s => s.id === sourceId);
          const targetSegment = targetTrack.segments.find(s => s.id === targetId);
          if (!sourceSegment || !targetSegment) return prev;

          const nextSourceOffset = clampOffsetForClip(
              targetSegment.sourceClipId,
              sourceSegment.duration,
              targetSegment.sourceStartOffset
          );
          const nextTargetOffset = clampOffsetForClip(
              sourceSegment.sourceClipId,
              targetSegment.duration,
              sourceSegment.sourceStartOffset
          );

          return prev.map(track => {
              if (track.id !== sourceTrack.id && track.id !== targetTrack.id) {
                  return track;
              }
              const nextSegments = track.segments.map(seg => {
                  if (seg.id === sourceSegment.id) {
                      return {
                          ...seg,
                          sourceClipId: targetSegment.sourceClipId,
                          sourceStartOffset: nextSourceOffset
                      };
                  }
                  if (seg.id === targetSegment.id) {
                      return {
                          ...seg,
                          sourceClipId: sourceSegment.sourceClipId,
                          sourceStartOffset: nextTargetOffset
                      };
                  }
                  return seg;
              });
              return { ...track, segments: nextSegments };
          });
      });

      setSwapMode(false);
      setSwapSourceId(null);
      setSelectedSegmentId(targetId);
  };

  const handleToggleSwapMode = (segmentId: string) => {
      if (swapMode && swapSourceId === segmentId) {
          setSwapMode(false);
          setSwapSourceId(null);
          return;
      }
      setSwapMode(true);
      setSwapSourceId(segmentId);
  };

  const handleSelectSegment = (id: string) => {
      if (swapMode && swapSourceId && id !== swapSourceId) {
          const sourceTrack = tracks.find(t => t.segments.some(s => s.id === swapSourceId));
          const targetTrack = tracks.find(t => t.segments.some(s => s.id === id));
          if (sourceTrack && targetTrack && sourceTrack.type === targetTrack.type) {
              handleSwapSegments(swapSourceId, id);
              return;
          }
          return;
      }
      setSelectedSegmentId(id);
  };

  const openAutoSyncDialog = () => {
      setAutoSyncBpm(Number.isFinite(beatGrid.bpm) ? beatGrid.bpm : 120);
      setAutoSyncIntroSkipFrames(introSkipFrames);
      setAutoSyncError(null);
      setAutoSyncOpen(true);
  };

  const closeAutoSyncDialog = () => {
      setAutoSyncOpen(false);
      setAutoSyncError(null);
  };

  const openExportDialog = () => {
      setExportProgress(0);
      setExportError(null);
      setExportOpen(true);
  };

  const closeExportDialog = () => {
      if (exporting) return;
      setExportOpen(false);
      setExportError(null);
  };

  const readFileAsDataUrl = async (filePath: string): Promise<string> => {
      const response = await fetch(toFileUrl(filePath));
      if (!response.ok) {
          throw new Error(`Failed to read file (${response.status})`);
      }
      const blob = await response.blob();
      return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
      });
  };

  const extractJsonFromText = (text: string) => {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) return null;
      try {
          return JSON.parse(text.slice(start, end + 1));
      } catch {
          return null;
      }
  };

  const handleGeminiAnalyze = async () => {
      const audioClip = clips.find(c => c.type === 'audio');
      if (!audioClip) {
          setAutoSyncError('Add an audio track before running Gemini analysis.');
          return;
      }

      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) {
          setAutoSyncError('Missing VITE_GEMINI_API_KEY in your environment.');
          return;
      }

      setAutoSyncAnalyzing(true);
      setAutoSyncError(null);

      try {
          const dataUrl = await readFileAsDataUrl(audioClip.filePath);
          const base64Data = dataUrl.split(',')[1];
          const mimeType = getMimeType(audioClip.filePath, audioClip.name);
          const videoClips = clips.filter(c => c.type === 'video');
          const clipDurationsSec = videoClips.map(c => c.duration / 1000);
          const shortestClipSec = clipDurationsSec.length > 0 ? Math.min(...clipDurationsSec) : 0;
          const prompt = [
              'Analyze this audio track and return a JSON object with these fields:',
              'bpm (number), clip_length_bars (number), intro_skip_frames (number).',
              `Imported video clip durations in seconds: ${clipDurationsSec.map(sec => sec.toFixed(2)).join(', ') || 'none'}.`,
              `Shortest clip length is ${shortestClipSec.toFixed(2)}s.`,
              'Choose clip_length_bars so that the clip length in seconds (bars * 60 * 4 / bpm) does not exceed the shortest clip length.',
              'intro_skip_frames means the number of frames to skip before the first beat so the first clip starts at that frame and all cuts line up with the beats and especially with the drop.',
              'intro_skip_frames should never be more than 4 bars.',
              'If unsure, provide best estimates. Return JSON only.'
          ].join(' ');

          const model = import.meta.env.VITE_GEMINI_MODEL || 'gemini-3-flash-preview';
          const response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      contents: [{
                          role: 'user',
                          parts: [
                              { text: prompt },
                              { inline_data: { mime_type: mimeType, data: base64Data } }
                          ]
                      }],
                      generationConfig: { temperature: 0.2 }
                  })
              }
          );

          if (!response.ok) {
              throw new Error(`Gemini request failed (${response.status})`);
          }

          const payload = await response.json();
          const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          const parsed = extractJsonFromText(text);
          if (!parsed) {
              throw new Error('Gemini response was not valid JSON.');
          }

          if (Number.isFinite(parsed.bpm)) setAutoSyncBpm(Number(parsed.bpm));
          if (Number.isFinite(parsed.clip_length_bars)) setAutoSyncBars(Math.round(Number(parsed.clip_length_bars)));
          if (Number.isFinite(parsed.intro_skip_frames)) setAutoSyncIntroSkipFrames(Math.round(Number(parsed.intro_skip_frames)));
      } catch (err) {
          setAutoSyncError(err instanceof Error ? err.message : 'Gemini analysis failed.');
      } finally {
          setAutoSyncAnalyzing(false);
      }
  };

  const applyAutoSyncSettings = () => {
      const videoClips = clips.filter(c => c.type === 'video');
      if (videoClips.length === 0) {
          setAutoSyncError('Add at least one video clip before auto-syncing.');
          return;
      }

      const clampedBpm = Math.min(300, Math.max(30, Number(autoSyncBpm)));
      const clampedBars = Math.min(8, Math.max(1, Math.round(Number(autoSyncBars))));
      const nextIntroSkipFrames = Math.round(Number(autoSyncIntroSkipFrames));

      const baseOffset = 0;
      const nextIntroSkipSec = nextIntroSkipFrames / DEFAULT_FPS;
      const rebuilt = buildBeatGrid(clampedBpm, baseOffset, duration / 1000);
      const shiftedBeats = rebuilt.beats.map(beat => Math.max(0, beat + nextIntroSkipSec));
      const nextBeatGrid = {
          ...rebuilt,
          offset: rebuilt.offset + nextIntroSkipSec,
          beats: [...new Set(shiftedBeats)].sort((a, b) => a - b),
          bpm: clampedBpm
      };

      if (nextBeatGrid.beats.length === 0) {
          setAutoSyncError('No beats detected after applying settings.');
          return;
      }

      setBeatGrid(nextBeatGrid);
      setIntroSkipFrames(nextIntroSkipFrames);

      const newSegments = autoSyncClips(videoClips, nextBeatGrid, duration, clampedBars);
      setTracks(prev => prev.map(t =>
        t.type === 'video' ? { ...t, segments: newSegments } : t
      ));
      setAutoSyncOpen(false);
  };

  const buildAutoSyncPreviewGrid = (nextBpm: number, nextIntroSkipFrames: number) => {
      const clampedBpm = Math.min(300, Math.max(30, Number(nextBpm)));
      const normalizedIntroSkipFrames = Math.round(Number(nextIntroSkipFrames));
      const baseOffset = 0;
      const introSkipSec = normalizedIntroSkipFrames / DEFAULT_FPS;
      const rebuilt = buildBeatGrid(clampedBpm, baseOffset, duration / 1000);
      const shiftedBeats = rebuilt.beats.map(beat => Math.max(0, beat + introSkipSec));
      return {
          ...rebuilt,
          offset: rebuilt.offset + introSkipSec,
          beats: [...new Set(shiftedBeats)].sort((a, b) => a - b),
          bpm: clampedBpm
      };
  };

  const togglePlay = () => {
    if (playbackState.isPlaying) {
        pause();
    } else {
        play();
    }
  };

  const play = () => {
    if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const ctx = audioContextRef.current!;
    if (ctx.state === 'suspended') ctx.resume();
    if (scrubPreviewSourceRef.current) {
        try { scrubPreviewSourceRef.current.stop(); } catch(e){}
        scrubPreviewSourceRef.current = null;
    }

    // Start audio if we have a master track
    if (masterAudioBufferRef.current) {
        // Stop previous if exists
        if (audioSourceNodeRef.current) {
            try { audioSourceNodeRef.current.stop(); } catch(e){}
        }

        const source = ctx.createBufferSource();
        source.buffer = masterAudioBufferRef.current;
        source.connect(ctx.destination);
        
        const offsetSec = playbackState.currentTime / 1000;
        source.start(0, offsetSec);
        audioSourceNodeRef.current = source;
    }

    startTimeRef.current = performance.now() - playbackState.currentTime;
    setPlaybackState(prev => ({ ...prev, isPlaying: true }));
    
    // Start loop
    cancelAnimationFrame(animationFrameRef.current);
    const loop = () => {
        const now = performance.now();
        let newTime = now - startTimeRef.current;
        
        if (newTime >= duration) {
            newTime = 0; // Loop
            startTimeRef.current = now;
            // Restart audio logic (simplified for loop)
            if (masterAudioBufferRef.current && audioSourceNodeRef.current) {
                try { audioSourceNodeRef.current.stop(); } catch(e){}
                const source = ctx.createBufferSource();
                source.buffer = masterAudioBufferRef.current;
                source.connect(ctx.destination);
                source.start(0, 0);
                audioSourceNodeRef.current = source;
            }
        }

        setPlaybackState(prev => ({ ...prev, currentTime: newTime }));
        animationFrameRef.current = requestAnimationFrame(loop);
    };
    loop();
  };

  const pause = () => {
    cancelAnimationFrame(animationFrameRef.current);
    if (audioSourceNodeRef.current) {
        try { audioSourceNodeRef.current.stop(); } catch(e){}
    }
    setPlaybackState(prev => ({ ...prev, isPlaying: false }));
  };

  const playScrubPreview = (timeMs: number) => {
      if (!masterAudioBufferRef.current) return;

      if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const ctx = audioContextRef.current!;
      if (ctx.state === 'suspended') ctx.resume();

      if (scrubPreviewSourceRef.current) {
          try { scrubPreviewSourceRef.current.stop(); } catch(e){}
      }

      const source = ctx.createBufferSource();
      source.buffer = masterAudioBufferRef.current;
      source.connect(ctx.destination);

      const frameSec = 1 / DEFAULT_FPS;
      const maxOffset = Math.max(0, source.buffer.duration - frameSec);
      const offsetSec = Math.min(Math.max(0, timeMs / 1000), maxOffset);
      source.start(0, offsetSec, frameSec);

      scrubPreviewSourceRef.current = source;
      source.onended = () => {
          if (scrubPreviewSourceRef.current === source) {
              scrubPreviewSourceRef.current = null;
          }
      };
  };

  const handleSeek = (timeMs: number) => {
      const wasPlaying = playbackState.isPlaying;
      if (wasPlaying) pause();
      setPlaybackState(prev => ({ ...prev, currentTime: timeMs }));
      playScrubPreview(timeMs);
      // If was playing, we might want to resume, but for editor usually pause on scrub is better
  };

  const handleJumpToStart = () => {
      handleSeek(0);
  };

  const handleUpdateSegment = (id: string, updates: Partial<ClipSegment>) => {
      setTracks(prev => prev.map(t => {
          const target = t.segments.find(s => s.id === id);
          if (!target) {
              return {
                  ...t,
                  segments: t.segments.map(s => s.id === id ? { ...s, ...updates } : s)
              };
          }

          const nextDuration = updates.duration ?? target.duration;
          const delta = nextDuration - target.duration;
          const oldEnd = target.timelineStart + target.duration;
          const shiftedSegments = t.segments.map(s => {
              if (s.id === id) {
                  return { ...s, ...updates, duration: nextDuration };
              }
              if (delta !== 0 && s.timelineStart >= oldEnd) {
                  return { ...s, timelineStart: s.timelineStart + delta };
              }
              return s;
          });

          return { ...t, segments: shiftedSegments };
      }));
  };

  const handleUpdateIntroSkipFrames = (nextFrames: number) => {
      if (beatGrid.beats.length === 0) {
          setIntroSkipFrames(Math.round(nextFrames));
          return;
      }
      const minBeat = Math.min(...beatGrid.beats);
      const maxNegativeFrames = Math.floor(minBeat * DEFAULT_FPS);
      const clampedFrames = Math.max(-maxNegativeFrames, Math.round(nextFrames));
      const deltaFrames = clampedFrames - introSkipFrames;
      if (deltaFrames === 0) {
          setIntroSkipFrames(clampedFrames);
          return;
      }
      const deltaSec = deltaFrames / DEFAULT_FPS;
      setBeatGrid(prev => ({
          ...prev,
          offset: prev.offset + deltaSec,
          beats: prev.beats.map(beat => Math.max(0, beat + deltaSec))
      }));
      setIntroSkipFrames(clampedFrames);
  };

  const handleUpdateBpm = useCallback((nextBpm: number) => {
      if (!Number.isFinite(nextBpm)) return;
      const clampedBpm = Math.min(300, Math.max(30, nextBpm));
      const introSkipSec = introSkipFrames / DEFAULT_FPS;
      setBeatGrid(prev => {
          const baseOffset = prev.offset - introSkipSec;
          const rebuilt = buildBeatGrid(clampedBpm, baseOffset, duration / 1000);
          const shiftedBeats = rebuilt.beats
              .map(beat => Math.max(0, beat + introSkipSec));
          return {
              ...rebuilt,
              offset: rebuilt.offset + introSkipSec,
              beats: [...new Set(shiftedBeats)].sort((a, b) => a - b),
          };
      });
  }, [duration, introSkipFrames]);

  const handleUpdateBarLength = useCallback((barLengthSec: number) => {
      if (!Number.isFinite(barLengthSec) || barLengthSec <= 0) return;
      const nextBpm = (60 * BEATS_PER_BAR) / barLengthSec;
      handleUpdateBpm(nextBpm);
  }, [handleUpdateBpm]);

  // --- Export Logic (Native FFmpeg) ---
  const handleExport = async () => {
      const videoSegments = tracks.find(t => t.type === 'video')?.segments || [];
      if (videoSegments.length === 0) {
          setExportError('Nothing to export yet. Add video clips to the timeline.');
          return;
      }
      if (!window.electronAPI?.ffmpeg?.run) {
          setExportError('Export is only available in the Electron app.');
          return;
      }
      const audioSegment = tracks.find(t => t.type === 'audio')?.segments[0] || null;
      const audioClip = audioSegment ? clips.find(c => c.id === audioSegment.sourceClipId) : null;

      setExporting(true);
      setExportProgress(0);
      setExportError(null);

      const [targetWidth, targetHeight] = exportResolution.split('x').map(Number);
      const outputFileName = `beatcutter-export-${Date.now()}.mp4`;
      const inputMap = new Map<string, { index: number; name: string }>();
      let inputIndex = 0;

      let didSucceed = false;
      let unsubscribeProgress: (() => void) | null = null;
      const jobId = uuidv4();
      try {
          const sortedSegments = [...videoSegments].sort((a, b) => a.timelineStart - b.timelineStart);
          for (const segment of sortedSegments) {
              const clip = clips.find(c => c.id === segment.sourceClipId);
              if (clip) {
                  if (clip.filePath.startsWith('blob:') || clip.filePath.startsWith('data:')) {
                      throw new Error('Export requires file paths. Re-import clips in the Electron app.');
                  }
                  if (!inputMap.has(clip.id)) {
                      inputMap.set(clip.id, { index: inputIndex++, name: clip.filePath });
                  }
              }
          }

          let audioInputIndex: number | null = null;
          if (audioClip) {
              if (audioClip.filePath.startsWith('blob:') || audioClip.filePath.startsWith('data:')) {
                  throw new Error('Export requires file paths. Re-import clips in the Electron app.');
              }
              if (!inputMap.has(audioClip.id)) {
                  inputMap.set(audioClip.id, { index: inputIndex++, name: audioClip.filePath });
              }
              audioInputIndex = inputMap.get(audioClip.id)?.index ?? null;
          }

          const filterParts: string[] = [];
          const concatInputs: string[] = [];
          sortedSegments.forEach((segment, idx) => {
              const input = inputMap.get(segment.sourceClipId);
              if (!input) return;
              const startSec = segment.sourceStartOffset / 1000;
              const durationSec = segment.duration / 1000;
              filterParts.push(
                  `[${input.index}:v]trim=start=${startSec.toFixed(3)}:duration=${durationSec.toFixed(3)},` +
                  `setpts=PTS-STARTPTS,scale=${targetWidth}:${targetHeight}:flags=fast_bilinear[v${idx}]`
              );
              concatInputs.push(`[v${idx}]`);
          });
          if (concatInputs.length === 0) {
              setExportError('No valid video segments to export. Check that clips still exist.');
              return;
          }

          const firstClipId = sortedSegments.find(segment => inputMap.has(segment.sourceClipId))?.sourceClipId;
          const firstClipPath = firstClipId ? inputMap.get(firstClipId)?.name ?? '' : '';
          if (!firstClipPath) {
              setExportError('Unable to resolve output folder for export.');
              return;
          }
          const outputDir = getDirName(firstClipPath);
          const outputPath = joinPath(outputDir, outputFileName);

          const outputDurationSec = sortedSegments.reduce((max, segment) => {
              const end = (segment.timelineStart + segment.duration) / 1000;
              return Math.max(max, end);
          }, 0);
          const audioFilter = audioInputIndex !== null && outputDurationSec > 0
              ? `;[${audioInputIndex}:a]apad,atrim=0:${outputDurationSec.toFixed(3)},asetpts=PTS-STARTPTS[outa]`
              : '';
          const filterComplex = `${filterParts.join(';')};${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0[outv]${audioFilter}`;
          const args: string[] = [];
          const is4kExport = targetWidth >= 3840 || targetHeight >= 2160;
          args.push('-loglevel', 'info');
          args.push('-y');
          inputMap.forEach((input) => {
              args.push('-i', input.name);
          });
          if (is4kExport) {
              args.push('-filter_complex_threads', '2');
          }
          args.push(
              '-filter_complex', filterComplex,
              '-map', '[outv]'
          );
          if (audioInputIndex !== null && outputDurationSec > 0) {
              args.push('-map', '[outa]');
          }
          const safeMbps = Number.isFinite(exportMbps) && exportMbps > 0 ? exportMbps : 8;
          if (is4kExport) {
              args.push('-threads', '2');
          }
          args.push(
              '-c:v', 'libx264',
              '-preset', 'ultrafast',
              '-bf', '0',
              '-vsync', 'cfr',
              '-r', `${DEFAULT_FPS}`,
              '-b:v', `${Math.max(1, safeMbps).toFixed(0)}M`,
              '-pix_fmt', 'yuv420p',
              '-profile:v', 'high',
              '-level:v', '5.1',
              '-c:a', 'aac',
              '-movflags', '+faststart',
              outputPath
          );

          unsubscribeProgress = onFfmpegProgress((progress) => {
              if (progress.jobId !== jobId) return;
              if (!Number.isFinite(progress.progress)) return;
              setExportProgress(Math.min(100, Math.round(progress.progress)));
          });

          const execResult = await runFfmpeg({ jobId, args, durationSec: outputDurationSec });
          if (execResult.exitCode !== 0 || execResult.signal) {
              console.error('FFmpeg export failed', execResult, { args });
              if (execResult.signal === 'SIGKILL') {
                  setExportError('Export failed (SIGKILL). The OS likely ran out of memory. Try 1080p or a shorter export.');
              } else {
                  setExportError(
                      `Export failed (ffmpeg code ${execResult.exitCode ?? 'unknown'}${execResult.signal ? `, signal ${execResult.signal}` : ''}). Check console logs for details.`
                  );
              }
              return;
          }
          setExportProgress(100);
          didSucceed = true;
      } catch (error) {
          console.error('Export failed', error);
          const message = error instanceof Error ? error.message : 'Export failed. Check the console for details.';
          setExportError(message);
      } finally {
          if (unsubscribeProgress) {
              unsubscribeProgress();
          }
          setExporting(false);
          if (didSucceed) {
              setExportOpen(false);
          }
      }
  };

  // --- Render ---
  return (
    <div className="flex flex-col h-screen bg-stone-950 text-stone-100 font-sans overflow-hidden">
        <Header 
            playbackState={playbackState} 
            onTogglePlay={togglePlay} 
            onJumpToStart={handleJumpToStart}
            onExport={openExportDialog}
            onAutoSync={openAutoSyncDialog}
            canSync={clips.some(c => c.type === 'video') && beatGrid.beats.length > 0}
            canOpenAutoSync={clips.length > 0}
            projectName="My Beat Video"
        />

        <div className="flex flex-1 overflow-hidden">
            {/* Left: Media Pool */}
            <MediaPool clips={clips} onImport={handleImport} onDelete={handleDeleteClip} />

            {/* Center: Preview Stage */}
            <div className="flex-1 flex flex-col bg-stone-950 relative min-w-0">
                <div className="flex-1 p-4 flex items-center justify-center">
                    <div className="aspect-video w-full max-w-4xl bg-stone-900 shadow-2xl rounded-lg overflow-hidden border border-stone-800">
                        <PreviewPlayer 
                            playbackState={playbackState} 
                            videoTrack={tracks.find(t => t.type === 'video')}
                            clips={clips}
                        />
                    </div>
                </div>
                
                {/* Bottom: Timeline */}
                <Timeline 
                    tracks={tracks} 
                    clips={clips}
                    playbackState={playbackState} 
                    beatGrid={
                      autoSyncOpen && Number.isFinite(autoSyncBpm) && Number.isFinite(autoSyncIntroSkipFrames)
                        ? buildAutoSyncPreviewGrid(autoSyncBpm, autoSyncIntroSkipFrames)
                        : beatGrid
                    }
                    waveform={waveform}
                    zoom={zoom}
                    duration={duration}
                    onSeek={handleSeek}
                    onSelectSegment={handleSelectSegment}
                    selectedSegmentId={selectedSegmentId}
                />
            </div>

            {/* Right: Inspector */}
            <Inspector 
                selectedSegmentId={selectedSegmentId}
                tracks={tracks}
                clips={clips}
                onUpdateSegment={handleUpdateSegment}
                onRemoveSegment={handleRemoveSegment}
                swapMode={swapMode}
                swapSourceId={swapSourceId}
                onToggleSwapMode={handleToggleSwapMode}
                introSkipFrames={introSkipFrames}
                onUpdateIntroSkipFrames={handleUpdateIntroSkipFrames}
                bpm={beatGrid.bpm}
                barLengthSec={(60 / beatGrid.bpm) * BEATS_PER_BAR}
                onUpdateBpm={handleUpdateBpm}
                onUpdateBarLength={handleUpdateBarLength}
            />
        </div>

        {autoSyncOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div
              role="dialog"
              aria-modal="true"
              className="w-[420px] max-w-[90vw] rounded-lg border border-stone-800 bg-stone-900 shadow-xl"
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-stone-800">
                <div>
                  <h2 className="text-lg font-semibold text-stone-100">Auto-Sync Settings</h2>
                  <p className="text-xs text-stone-400 mt-1">Fine-tune timing before generating cuts.</p>
                </div>
                <button
                  onClick={closeAutoSyncDialog}
                  className="text-stone-400 hover:text-stone-200 text-xl leading-none"
                  aria-label="Close auto-sync dialog"
                >
                  x
                </button>
              </div>

              <div className="px-5 py-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-stone-400 uppercase tracking-wide">
                    BPM
                    <input
                      type="number"
                      min={30}
                      max={300}
                      step={1}
                      value={autoSyncBpm}
                      onChange={(e) => setAutoSyncBpm(Number(e.target.value))}
                      className="mt-2 w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                    />
                  </label>
                  <label className="text-xs text-stone-400 uppercase tracking-wide">
                    Clip Length (bars)
                    <input
                      type="number"
                      min={1}
                      max={8}
                      step={1}
                      value={autoSyncBars}
                      onChange={(e) => setAutoSyncBars(Number(e.target.value))}
                      className="mt-2 w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                    />
                  </label>
                </div>

                <label className="text-xs text-stone-400 uppercase tracking-wide">
                  Intro Skip (frames)
                  <input
                    type="number"
                    value={autoSyncIntroSkipFrames}
                    onChange={(e) => setAutoSyncIntroSkipFrames(Number(e.target.value))}
                    className="mt-2 w-full bg-stone-800 border border-stone-700 rounded px-2 py-1 text-sm text-stone-200"
                  />
                </label>

                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={handleGeminiAnalyze}
                    disabled={autoSyncAnalyzing}
                    className={`flex-1 rounded border px-3 py-2 text-sm font-medium transition-colors ${
                      autoSyncAnalyzing
                        ? 'border-stone-700 text-stone-500 cursor-not-allowed'
                        : 'border-amber-400 text-amber-300 hover:bg-amber-400/10'
                    }`}
                  >
                    {autoSyncAnalyzing ? 'Analyzing with Gemini...' : 'Use Gemini 3 Flash'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAutoSyncBpm(beatGrid.bpm);
                      setAutoSyncIntroSkipFrames(introSkipFrames);
                      setAutoSyncBars(4);
                    }}
                    className="px-3 py-2 text-sm text-stone-400 hover:text-stone-200"
                  >
                    Reset
                  </button>
                </div>

                {autoSyncError && (
                  <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded px-3 py-2">
                    {autoSyncError}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-stone-800">
                <button
                  type="button"
                  onClick={closeAutoSyncDialog}
                  className="px-3 py-2 text-sm text-stone-400 hover:text-stone-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={applyAutoSyncSettings}
                  className="px-4 py-2 text-sm font-semibold rounded bg-amber-500 hover:bg-amber-400 text-stone-950"
                >
                  Auto-Sync Clips
                </button>
              </div>
            </div>
          </div>
        )}

        {exportOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div
              role="dialog"
              aria-modal="true"
              className="w-[420px] max-w-[90vw] rounded-lg border border-stone-800 bg-stone-900 shadow-xl"
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-stone-800">
                <div>
                  <h2 className="text-lg font-semibold text-stone-100">Export Video</h2>
                  <p className="text-xs text-stone-400 mt-1">Render the timeline with native FFmpeg.</p>
                </div>
                <button
                  onClick={closeExportDialog}
                  className="text-stone-400 hover:text-stone-200"
                  aria-label="Close export dialog"
                  disabled={exporting}
                >
                  ✕
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs text-stone-400 mb-2 uppercase">Resolution</label>
                  <select
                    value={exportResolution}
                    onChange={(e) => setExportResolution(e.target.value)}
                    className="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 text-sm text-stone-200"
                    disabled={exporting}
                  >
                    <option value="1280x720">720p (1280x720)</option>
                    <option value="1920x1080">1080p (1920x1080)</option>
                    <option value="3840x2160">4K (3840x2160)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-stone-400 mb-2 uppercase">Video Bitrate (Mbps)</label>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    step={1}
                    value={exportMbps}
                    onChange={(e) => {
                      const nextValue = Number(e.target.value);
                      setExportMbps(Number.isFinite(nextValue) ? nextValue : 8);
                    }}
                    className="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 text-sm text-stone-200"
                    disabled={exporting}
                  />
                </div>

                {exportError && (
                  <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded px-3 py-2">
                    {exportError}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-stone-500">
                    <span>Progress</span>
                    <span>{exportProgress}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{ width: `${exportProgress}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-stone-500">
                  <span>Large exports may take a while.</span>
                  {exporting && <span className="text-amber-300">Exporting…</span>}
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-stone-800">
                <button
                  onClick={closeExportDialog}
                  className="px-4 py-2 rounded border border-stone-700 text-stone-200 hover:bg-stone-800"
                  disabled={exporting}
                >
                  Cancel
                </button>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className={`px-5 py-2 rounded font-semibold ${
                    exporting
                      ? 'bg-stone-700 text-stone-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-500 text-white'
                  }`}
                >
                  Export
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
};

export default App;
