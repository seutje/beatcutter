import React, { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Project, SourceClip, TimelineTrack, BeatGrid, PlaybackState, ClipSegment } from './types';
import { decodeAudio, analyzeBeats, generateWaveform } from './services/audioUtils';
import { autoSyncClips } from './services/syncEngine';
import { DEFAULT_ZOOM } from './constants';
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
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    isPlaying: false,
    currentTime: 0,
    playbackRate: 1
  });
  const [duration, setDuration] = useState<number>(30000); // 30s default
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);

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
                 const waveformPoints = Math.min(4000, Math.max(600, Math.floor(buffer.duration * 60)));
                 setWaveform(generateWaveform(buffer, waveformPoints));
                 setDuration(buffer.duration * 1000);
                 
                 // Add to audio track
                 setTracks(prev => prev.map(t => 
                    t.type === 'audio' ? { 
                        ...t, 
                        segments: [{ 
                            id: uuidv4(), 
                            sourceClipId: 'audio-main', // placeholder
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
            id: uuidv4(),
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

  const handleAutoSync = () => {
      const videoClips = clips.filter(c => c.type === 'video');
      if (videoClips.length === 0 || beatGrid.beats.length === 0) {
          alert("Need video clips and analyzed audio to sync.");
          return;
      }

      const newSegments = autoSyncClips(videoClips, beatGrid, duration);
      
      setTracks(prev => prev.map(t => 
        t.type === 'video' ? { ...t, segments: newSegments } : t
      ));
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

  const handleUpdateSegment = (id: string, updates: Partial<ClipSegment>) => {
      setTracks(prev => prev.map(t => ({
          ...t,
          segments: t.segments.map(s => s.id === id ? { ...s, ...updates } : s)
      })));
  };

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
    <div className="flex flex-col h-screen bg-gray-950 text-white font-sans overflow-hidden">
        <Header 
            playbackState={playbackState} 
            onTogglePlay={togglePlay} 
            onExport={handleExport}
            onAutoSync={handleAutoSync}
            canSync={clips.some(c => c.type === 'video') && beatGrid.beats.length > 0}
            projectName="My Beat Video"
        />

        <div className="flex flex-1 overflow-hidden">
            {/* Left: Media Pool */}
            <MediaPool clips={clips} onImport={handleImport} onDelete={handleDeleteClip} />

            {/* Center: Preview Stage */}
            <div className="flex-1 flex flex-col bg-black relative min-w-0">
                <div className="flex-1 p-4 flex items-center justify-center">
                    <div className="aspect-video w-full max-w-4xl bg-gray-900 shadow-2xl rounded-lg overflow-hidden border border-gray-800">
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
                segments={tracks.find(t => t.type === 'video')?.segments || []}
                clips={clips}
                onUpdateSegment={handleUpdateSegment}
            />
        </div>
    </div>
  );
};

export default App;
