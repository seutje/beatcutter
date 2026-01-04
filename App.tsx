import React, { useState, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Project, SourceClip, TimelineTrack, BeatGrid, PlaybackState, ClipSegment } from './types';
import { decodeAudio, analyzeBeats, buildBeatGrid, generateWaveform } from './services/audioUtils';
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
  const [autoSyncOpen, setAutoSyncOpen] = useState<boolean>(false);
  const [autoSyncBpm, setAutoSyncBpm] = useState<number>(120);
  const [autoSyncBars, setAutoSyncBars] = useState<number>(4);
  const [autoSyncIntroSkipFrames, setAutoSyncIntroSkipFrames] = useState<number>(0);
  const [autoSyncError, setAutoSyncError] = useState<string | null>(null);
  const [autoSyncAnalyzing, setAutoSyncAnalyzing] = useState<boolean>(false);

  // --- Refs for Audio Engine ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const masterAudioBufferRef = useRef<AudioBuffer | null>(null);
  const startTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);

  // --- Handlers ---

  const handleImport = async (fileList: FileList) => {
    const newClips: SourceClip[] = [];
    // Convert FileList to Array immediately to preserve references when input is reset
    const files = Array.from(fileList);
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const clipId = uuidv4();
        const isAudio = file.type.startsWith('audio');
        
        // Create Object URL for preview
        const objectUrl = URL.createObjectURL(file);
        
        // Get Duration (Basic Estimate)
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
               
               // If it's the first audio, analyze it!
               if (!masterAudioBufferRef.current && duration > 0) {
                 const buffer = await decodeAudio(file);
                 masterAudioBufferRef.current = buffer;
                 const analysis = analyzeBeats(buffer);
                 setBeatGrid(analysis);
                 setIntroSkipFrames(0);
                 const waveformPoints = Math.min(4000, Math.max(600, Math.floor(buffer.duration * 60)));
                 setWaveform(generateWaveform(buffer, waveformPoints));
                 setDuration(buffer.duration * 1000);
                 
                 // Add to audio track
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
            console.error("Error loading metadata for", file.name, e);
        }

        newClips.push({
            id: clipId,
            fileHandle: file,
            duration: duration || 1000,
            thumbnailUrl: '', // Could generate using canvas
            name: file.name,
            type: isAudio ? 'audio' : 'video',
            objectUrl
        });
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

  const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
  });

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
          const dataUrl = await readFileAsDataUrl(audioClip.fileHandle);
          const base64Data = dataUrl.split(',')[1];
          const mimeType = audioClip.fileHandle.type || 'audio/mpeg';
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
              'If unsure, provide best estimates. Return JSON only.'
          ].join(' ');

          const model = import.meta.env.VITE_GEMINI_MODEL || 'gemini-2.0-flash';
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

      const currentIntroSkipSec = introSkipFrames / DEFAULT_FPS;
      const baseOffset = beatGrid.offset - currentIntroSkipSec;
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

  const handleSeek = (timeMs: number) => {
      const wasPlaying = playbackState.isPlaying;
      if (wasPlaying) pause();
      setPlaybackState(prev => ({ ...prev, currentTime: timeMs }));
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

  // --- Export Logic (FFmpeg command generation) ---
  const handleExport = () => {
      // Construct the complex filter command
      const videoSegments = tracks.find(t => t.type === 'video')?.segments || [];
      const audioTrack = tracks.find(t => t.type === 'audio'); // Assuming single audio file for now
      
      if (videoSegments.length === 0) {
          alert("Nothing to export!");
          return;
      }

      // Collect unique inputs
      const inputs = new Map<string, number>(); // clipId -> inputIndex
      const inputList: string[] = [];
      let inputCounter = 0;

      // Add audio input
      const audioInputIndex = inputCounter++;
      const audioFileName = "master_audio.mp3"; // Placeholder name
      inputList.push(`-i "${audioFileName}"`);

      // Add video inputs
      videoSegments.forEach(seg => {
          if (!inputs.has(seg.sourceClipId)) {
              const clip = clips.find(c => c.id === seg.sourceClipId);
              if (clip) {
                  inputs.set(seg.sourceClipId, inputCounter++);
                  inputList.push(`-i "${clip.name}"`);
              }
          }
      });

      // Build Filter Complex
      let filterComplex = "";
      let concatInputs = "";

      videoSegments.forEach((seg, idx) => {
          const inputIdx = inputs.get(seg.sourceClipId);
          const startSec = seg.sourceStartOffset / 1000;
          const durationSec = seg.duration / 1000;
          const scale = "scale=1920:1080"; // standardize resolution
          
          // Trimming and resetting timestamps
          // [0:v]trim=start=10:duration=2,setpts=PTS-STARTPTS,scale=1920:1080[v0];
          filterComplex += `[${inputIdx}:v]trim=start=${startSec.toFixed(3)}:duration=${durationSec.toFixed(3)},setpts=PTS-STARTPTS,${scale}[v${idx}];`;
          concatInputs += `[v${idx}]`;
      });

      // Concat
      filterComplex += `${concatInputs}concat=n=${videoSegments.length}:v=1:a=0[outv]`;

      const ffmpegCommand = `ffmpeg ${inputList.join(' ')} -filter_complex "${filterComplex}" -map "[outv]" -map ${audioInputIndex}:a -c:v libx264 -preset ultrafast -c:a aac output.mp4`;

      console.log("GENERATED FFMPEG COMMAND:", ffmpegCommand);
      
      const blob = new Blob([ffmpegCommand], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'export_command.sh';
      a.click();
      alert("Export Manifest/Script downloaded! (Check console for full command). Browser-based FFmpeg execution requires SharedArrayBuffer headers which may not be present in this preview environment.");
  };

  // --- Render ---
  return (
    <div className="flex flex-col h-screen bg-stone-950 text-stone-100 font-sans overflow-hidden">
        <Header 
            playbackState={playbackState} 
            onTogglePlay={togglePlay} 
            onJumpToStart={handleJumpToStart}
            onExport={handleExport}
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
                    playbackState={playbackState} 
                    beatGrid={beatGrid}
                    waveform={waveform}
                    zoom={zoom}
                    duration={duration}
                    onSeek={handleSeek}
                    onSelectSegment={setSelectedSegmentId}
                    selectedSegmentId={selectedSegmentId}
                />
            </div>

            {/* Right: Inspector */}
            <Inspector 
                selectedSegmentId={selectedSegmentId}
                tracks={tracks}
                clips={clips}
                onUpdateSegment={handleUpdateSegment}
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
    </div>
  );
};

export default App;
