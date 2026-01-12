import React, { useState, useCallback, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { SourceClip, TimelineTrack, BeatGrid, PlaybackState, ClipSegment, SavedProject, SerializableClip } from './types';
import { decodeAudio, analyzeBeats, buildBeatGrid, generateWaveform } from './services/audioUtils';
import { runFfmpeg, onFfmpegProgress } from './services/ffmpegBridge';
import { runProxy, cancelProxy } from './services/proxyManager';
import { autoSyncClips } from './services/syncEngine';
import { DEFAULT_ZOOM, DEFAULT_FPS, BEATS_PER_BAR, TIMELINE_ZOOM_MIN, TIMELINE_ZOOM_MAX } from './constants';
import Header from './components/Header';
import MediaPool from './components/MediaPool';
import Timeline from './components/Timeline';
import Inspector from './components/Inspector';
import PreviewPlayer from './components/PreviewPlayer';

const LAST_PROJECT_STORAGE_KEY = 'beatcutter:lastProjectPath';
const PROJECT_FILE_SUFFIX = '.beatcutter.json';

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
  const [selectedMediaClipId, setSelectedMediaClipId] = useState<string | null>(null);
  const [mediaClipBars, setMediaClipBars] = useState<number>(4);
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
  const [useProxies, setUseProxies] = useState<boolean>(false);
  const [optionsOpen, setOptionsOpen] = useState<boolean>(false);
  const [geminiApiKey, setGeminiApiKey] = useState<string>('');
  const [projectName, setProjectName] = useState<string>('My Beat Video');
  const [projectIoStatus, setProjectIoStatus] = useState<string | null>(null);
  const [lastProjectPath, setLastProjectPath] = useState<string | null>(null);

  // --- Refs for Audio Engine ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const scrubPreviewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const masterAudioBufferRef = useRef<AudioBuffer | null>(null);
  const startTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);
  const proxyJobsRef = useRef<Map<string, string>>(new Map());
  const reverseProxyJobsRef = useRef<Map<string, string>>(new Map());
  const reverseProxyDebounceRef = useRef<number | null>(null);
  const defaultFadeIn = { enabled: false, startMs: 0, endMs: 500 };
  const defaultFadeOut = { enabled: false, startMs: -500, endMs: 0 };

  // --- Handlers ---
  const clampZoom = useCallback(
    (value: number) => Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, value)),
    []
  );

  const handleZoomChange = useCallback((nextZoom: number) => {
    setZoom(clampZoom(nextZoom));
  }, [clampZoom]);

  const encodePathForUrl = useCallback((filePath: string) => {
      const normalized = filePath.replace(/\\/g, '/');
      if (/^[A-Za-z]:\//.test(normalized)) {
          const drive = normalized.slice(0, 2);
          const rest = normalized.slice(2);
          const encodedRest = rest
              .split('/')
              .map(segment => encodeURIComponent(segment))
              .join('/');
          return `${drive}${encodedRest}`;
      }
      const leadingSlash = normalized.startsWith('/') ? '/' : '';
      const trimmed = normalized.startsWith('/') ? normalized.slice(1) : normalized;
      const encoded = trimmed
          .split('/')
          .map(segment => encodeURIComponent(segment))
          .join('/');
      return `${leadingSlash}${encoded}`;
  }, []);

  const toFileUrl = useCallback((filePath: string) => {
      if (
          filePath.startsWith('file://') ||
          filePath.startsWith('media://') ||
          filePath.startsWith('blob:') ||
          filePath.startsWith('data:')
      ) {
          return filePath;
      }
      if (window.electronAPI) {
          const encoded = encodePathForUrl(filePath);
          if (/^[A-Za-z]:\//.test(encoded)) {
              return `media:///${encoded}`;
          }
          const withLeadingSlash = encoded.startsWith('/') ? encoded : `/${encoded}`;
          return `media://${withLeadingSlash}`;
      }
      const encoded = encodePathForUrl(filePath);
      const prefix = encoded.startsWith('/') ? 'file://' : 'file:///';
      return `${prefix}${encoded}`;
  }, [encodePathForUrl]);

  const toPlaybackUrl = useCallback((filePath: string) => {
      if (
          filePath.startsWith('file://') ||
          filePath.startsWith('media://') ||
          filePath.startsWith('blob:') ||
          filePath.startsWith('data:')
      ) {
          return filePath;
      }
      if (window.electronAPI) {
          const encoded = encodePathForUrl(filePath);
          const prefix = encoded.startsWith('/') ? 'file://' : 'file:///';
          return `${prefix}${encoded}`;
      }
      return toFileUrl(filePath);
  }, [encodePathForUrl, toFileUrl]);

  const getMediaDuration = async (urls: string[], kind: 'audio' | 'video') => {
      for (const url of urls) {
          const duration = await new Promise<number>((resolve) => {
              const el = document.createElement(kind);
              el.preload = 'metadata';
              el.onloadedmetadata = () => resolve(el.duration * 1000);
              el.onerror = () => resolve(0);
              el.src = url;
          });
          if (duration > 0) return duration;
      }
      return 0;
  };

  const decodeAudioWithFallback = useCallback(async (urls: string[]) => {
      let lastError: unknown = null;
      for (const url of urls) {
          try {
              return await decodeAudio(url);
          } catch (error) {
              lastError = error;
          }
      }
      if (lastError) {
          throw lastError;
      }
      throw new Error('Unable to decode audio.');
  }, []);

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

  const stripExtension = (fileName: string) => {
      const idx = fileName.lastIndexOf('.');
      return idx > 0 ? fileName.slice(0, idx) : fileName;
  };

  const getPrimaryAudioClip = (items: SerializableClip[]) => {
      const mp3Clip = items.find(
          (clip) => clip.type === 'audio' && getExtension(clip.filePath, clip.name) === 'mp3'
      );
      return mp3Clip ?? items.find((clip) => clip.type === 'audio') ?? null;
  };

  const getProjectFilePath = (audioClip: SerializableClip) => {
      if (audioClip.filePath.startsWith('blob:') || audioClip.filePath.startsWith('data:')) {
          return null;
      }
      const dir = getDirName(audioClip.filePath);
      const base = stripExtension(getBaseName(audioClip.filePath));
      return joinPath(dir, `${base}${PROJECT_FILE_SUFFIX}`);
  };

  const getProxyPath = (filePath: string) => {
      const dir = getDirName(filePath);
      const baseName = getBaseName(filePath);
      const baseStem = stripExtension(baseName);
      const proxyDir = joinPath(dir, 'proxies');
      return joinPath(proxyDir, `${baseStem}.proxy.mp4`);
  };

  const getReverseProxyPath = (filePath: string) => {
      const dir = getDirName(filePath);
      const baseName = getBaseName(filePath);
      const baseStem = stripExtension(baseName);
      const proxyDir = joinPath(dir, 'proxies');
      return joinPath(proxyDir, `${baseStem}.reverse.proxy.mp4`);
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
        const baseNameForDisplay = filePath.startsWith('blob:') && nameOverride
            ? nameOverride
            : getBaseName(filePath);
        if (getExtension(filePath, nameOverride) === 'mp3') {
            setProjectName(stripExtension(baseNameForDisplay));
        }
        const fileUrl = toFileUrl(filePath);
        const objectUrl = toPlaybackUrl(filePath);
        const urlCandidates = Array.from(new Set([objectUrl, fileUrl]));
        let duration = 0;

        try {
            if (isAudio) {
               duration = await getMediaDuration(urlCandidates, 'audio');

               if (!masterAudioBufferRef.current && duration > 0) {
                 const buffer = await decodeAudioWithFallback(urlCandidates);
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
                            sourceStartOffset: 0,
                            playbackRate: 1,
                            fadeIn: { ...defaultFadeIn },
                            fadeOut: { ...defaultFadeOut }
                        }]
                    } : t
                 ));
               }
            } else {
               duration = await getMediaDuration(urlCandidates, 'video');
            }
        } catch (e) {
            console.error("Error loading metadata for", filePath, e);
        }

        newClips.push({
            id: clipId,
            filePath,
            duration: duration || 1000,
            thumbnailUrl: '',
            name: nameOverride ?? baseNameForDisplay,
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
    if (useProxies) {
        newClips.forEach((clip) => {
            void startProxyGeneration(clip);
        });
    }
  };

  const buildProjectPayload = (): SavedProject => ({
      version: 1,
      projectName,
      clips: clips.map(({ objectUrl, ...rest }) => rest),
      tracks,
      beatGrid,
      waveform,
      introSkipFrames,
      duration,
      zoom,
      useProxies
  });

  const applyProjectPayload = useCallback(async (payload: SavedProject, filePath: string, silent?: boolean) => {
      const nextClips = Array.isArray(payload.clips)
          ? payload.clips.map((clip) => ({
              ...clip,
              objectUrl: toPlaybackUrl(clip.filePath)
          }))
          : [];
      const nextTracks = Array.isArray(payload.tracks) && payload.tracks.length > 0
          ? payload.tracks
          : [
              { id: 'video-1', type: 'video', segments: [] },
              { id: 'audio-1', type: 'audio', segments: [] }
          ];
      const nextBeatGrid = payload.beatGrid ?? { bpm: 120, offset: 0, beats: [] };

      setProjectName(payload.projectName || 'My Beat Video');
      setClips(nextClips);
      setTracks(nextTracks);
      setBeatGrid(nextBeatGrid);
      setWaveform(Array.isArray(payload.waveform) ? payload.waveform : []);
      setIntroSkipFrames(Number.isFinite(payload.introSkipFrames) ? payload.introSkipFrames : 0);
      setDuration(Number.isFinite(payload.duration) ? payload.duration : 30000);
      setZoom(clampZoom(Number.isFinite(payload.zoom) ? payload.zoom : DEFAULT_ZOOM));
      setUseProxies(Boolean(payload.useProxies));
      setSelectedSegmentId(null);
      setSwapMode(false);
      setSwapSourceId(null);
      setPlaybackState(prev => ({ ...prev, isPlaying: false, currentTime: 0 }));

      masterAudioBufferRef.current = null;
      const primaryAudio = getPrimaryAudioClip(nextClips);
      if (primaryAudio) {
          try {
              const urlCandidates = [
                  toFileUrl(primaryAudio.filePath),
                  toPlaybackUrl(primaryAudio.filePath)
              ];
              const buffer = await decodeAudioWithFallback(urlCandidates);
              masterAudioBufferRef.current = buffer;
              if (!payload.waveform || payload.waveform.length === 0) {
                  const waveformPoints = Math.min(4000, Math.max(600, Math.floor(buffer.duration * 60)));
                  setWaveform(generateWaveform(buffer, waveformPoints));
              }
              if (!Number.isFinite(payload.duration) || payload.duration <= 0) {
                  setDuration(buffer.duration * 1000);
              }
          } catch (error) {
              console.warn('Failed to decode audio for loaded project', error);
          }
      }

      setLastProjectPath(filePath);
      localStorage.setItem(LAST_PROJECT_STORAGE_KEY, filePath);
      if (!silent) {
          setProjectIoStatus(`Loaded project from ${filePath}`);
      }
  }, [clampZoom, decodeAudioWithFallback, toFileUrl, toPlaybackUrl]);

  const loadProjectFromPath = useCallback(async (filePath: string, silent?: boolean) => {
      if (!window.electronAPI?.project?.load) {
          setProjectIoStatus('Project loading is only available in the Electron app.');
          return;
      }
      try {
          const result = await window.electronAPI.project.load({ filePath });
          if (!result.ok || !result.data) {
              throw new Error(result.error || 'Project load failed.');
          }
          const parsed = JSON.parse(result.data) as SavedProject;
          if (!parsed || typeof parsed !== 'object') {
              throw new Error('Project file is invalid.');
          }
          await applyProjectPayload(parsed, filePath, silent);
      } catch (error) {
          setProjectIoStatus(error instanceof Error ? error.message : 'Project load failed.');
      }
  }, [applyProjectPayload]);

  const handleSaveProject = async () => {
      if (!window.electronAPI?.project?.save) {
          setProjectIoStatus('Project saving is only available in the Electron app.');
          return;
      }
      const serializableClips: SerializableClip[] = clips.map(({ objectUrl, ...rest }) => rest);
      const invalidClip = serializableClips.find(
          (clip) => clip.filePath.startsWith('blob:') || clip.filePath.startsWith('data:')
      );
      if (invalidClip) {
          setProjectIoStatus('Project saving requires file-based media. Re-import clips in Electron.');
          return;
      }
      const primaryAudio = getPrimaryAudioClip(serializableClips);
      if (!primaryAudio) {
          setProjectIoStatus('Add an MP3 before saving the project.');
          return;
      }
      const projectPath = getProjectFilePath(primaryAudio);
      if (!projectPath) {
          setProjectIoStatus('Unable to resolve a project file path.');
          return;
      }
      const payload = buildProjectPayload();
      const result = await window.electronAPI.project.save({
          filePath: projectPath,
          data: JSON.stringify(payload, null, 2)
      });
      if (!result.ok) {
          setProjectIoStatus(result.error || 'Project save failed.');
          return;
      }
      setLastProjectPath(projectPath);
      localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectPath);
      setProjectIoStatus(`Saved project to ${projectPath}`);
  };

  const handleLoadLastProject = () => {
      if (!lastProjectPath) {
          setProjectIoStatus('No saved project found.');
          return;
      }
      void loadProjectFromPath(lastProjectPath);
  };

  const handleNewProject = () => {
      if (playbackState.isPlaying) {
          pause();
      }
      if (scrubPreviewSourceRef.current) {
          try { scrubPreviewSourceRef.current.stop(); } catch (e) {}
          scrubPreviewSourceRef.current = null;
      }
      proxyJobsRef.current.forEach((jobId) => {
          if (window.electronAPI?.proxy?.cancel) {
              cancelProxy(jobId);
          }
      });
      proxyJobsRef.current.clear();
      reverseProxyJobsRef.current.forEach((jobId) => {
          if (window.electronAPI?.proxy?.cancel) {
              cancelProxy(jobId);
          }
      });
      reverseProxyJobsRef.current.clear();

      setClips([]);
      setTracks([
          { id: 'video-1', type: 'video', segments: [] },
          { id: 'audio-1', type: 'audio', segments: [] }
      ]);
      setBeatGrid({ bpm: 120, offset: 0, beats: [] });
      setWaveform([]);
      setIntroSkipFrames(0);
      setDuration(30000);
      setSelectedSegmentId(null);
      setSelectedMediaClipId(null);
      setSwapMode(false);
      setSwapSourceId(null);
      setAutoSyncOpen(false);
      setAutoSyncError(null);
      setAutoSyncAnalyzing(false);
      setPlaybackState(prev => ({ ...prev, isPlaying: false, currentTime: 0 }));
      setProjectName('My Beat Video');
      setProjectIoStatus('Started a new project.');
      masterAudioBufferRef.current = null;
  };

  // Debounce reverse proxies so toggling/editing segments doesn't start renders too eagerly.
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || isEditableTarget(event.target)) return;
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((prev) => clampZoom(prev * 1.1));
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom((prev) => clampZoom(prev * 0.9));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clampZoom]);

  useEffect(() => {
      const storedPath = localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
      if (storedPath) {
          setLastProjectPath(storedPath);
          if (window.electronAPI?.project?.load) {
              void loadProjectFromPath(storedPath, true);
          }
      }
  }, [loadProjectFromPath]);

  const handleDeleteClip = (id: string) => {
      const jobId = proxyJobsRef.current.get(id);
      if (jobId && window.electronAPI?.proxy?.cancel) {
          cancelProxy(jobId);
          proxyJobsRef.current.delete(id);
      }
      const reverseJobId = reverseProxyJobsRef.current.get(id);
      if (reverseJobId && window.electronAPI?.proxy?.cancel) {
          cancelProxy(reverseJobId);
          reverseProxyJobsRef.current.delete(id);
      }
      const targetClip = clips.find(c => c.id === id);
      const hasRemainingAudio = clips.some(c => c.id !== id && c.type === 'audio');
      setClips(prev => prev.filter(c => c.id !== id));
      // Remove segments from timeline that use this clip
      setTracks(prev => prev.map(t => ({
          ...t,
          segments: t.segments.filter(s => s.sourceClipId !== id)
      })));
      if (targetClip?.type === 'audio' && !hasRemainingAudio) {
          masterAudioBufferRef.current = null;
          setWaveform([]);
          setBeatGrid({ bpm: 120, offset: 0, beats: [] });
          setIntroSkipFrames(0);
          setDuration(30000);
      }
      if (selectedMediaClipId === id) {
          setSelectedMediaClipId(null);
      }
  };

  const startProxyGeneration = async (clip: SourceClip) => {
      if (!window.electronAPI?.proxy?.run) return;
      if (clip.type !== 'video') return;
      if (clip.filePath.startsWith('blob:') || clip.filePath.startsWith('data:')) return;
      if (clip.proxyPath) return;
      if (proxyJobsRef.current.has(clip.id)) return;
      if (reverseProxyJobsRef.current.has(clip.id)) return;

      const outputPath = getProxyPath(clip.filePath);
      const jobId = uuidv4();
      proxyJobsRef.current.set(clip.id, jobId);

      try {
          const execResult = await runProxy({
              jobId,
              inputPath: clip.filePath,
              outputPath,
              durationSec: clip.duration / 1000,
          });
          if (execResult.exitCode !== 0 || execResult.signal) {
              console.warn('Proxy generation failed', execResult, clip.filePath);
              return;
          }
          setClips(prev => prev.map(c => c.id === clip.id ? { ...c, proxyPath: outputPath } : c));
      } catch (error) {
          console.warn('Proxy generation error', error);
      } finally {
          proxyJobsRef.current.delete(clip.id);
      }
  };

  const startReverseProxyGeneration = async (clip: SourceClip) => {
      if (!window.electronAPI?.proxy?.run) return;
      if (clip.type !== 'video') return;
      if (clip.filePath.startsWith('blob:') || clip.filePath.startsWith('data:')) return;
      if (clip.reverseProxyPath) return;
      if (reverseProxyJobsRef.current.has(clip.id)) return;
      if (proxyJobsRef.current.has(clip.id)) return;

      const outputPath = getReverseProxyPath(clip.filePath);
      const jobId = uuidv4();
      reverseProxyJobsRef.current.set(clip.id, jobId);

      try {
          const execResult = await runProxy({
              jobId,
              inputPath: clip.filePath,
              outputPath,
              durationSec: clip.duration / 1000,
              reverse: true,
          });
          if (execResult.exitCode !== 0 || execResult.signal) {
              console.warn('Reverse proxy generation failed', execResult, clip.filePath);
              return;
          }
          setClips(prev => prev.map(c => c.id === clip.id ? { ...c, reverseProxyPath: outputPath } : c));
      } catch (error) {
          console.warn('Reverse proxy generation error', error);
      } finally {
          reverseProxyJobsRef.current.delete(clip.id);
      }
  };

  const resolvePreviewUrl = useCallback((clip: SourceClip, segment?: ClipSegment) => {
      if (segment?.reverse) {
          if (clip.reverseProxyPath) {
              return toPlaybackUrl(clip.reverseProxyPath);
          }
          if (useProxies && clip.proxyPath) {
              return toPlaybackUrl(clip.proxyPath);
          }
      }
      if (useProxies && clip.proxyPath) {
          return toPlaybackUrl(clip.proxyPath);
      }
      return toPlaybackUrl(clip.filePath);
  }, [useProxies, toPlaybackUrl]);

  useEffect(() => {
      if (!useProxies) return;
      clips.forEach((clip) => {
          if (!clip.proxyPath) {
              void startProxyGeneration(clip);
          }
      });
  }, [useProxies, clips]);

  useEffect(() => {
      if (!window.electronAPI?.proxy?.run) return;
      const reversedClipIds = new Set<string>();
      tracks.forEach((track) => {
          track.segments.forEach((segment) => {
              if (segment.reverse) {
                  reversedClipIds.add(segment.sourceClipId);
              }
          });
      });

      if (reverseProxyDebounceRef.current) {
          window.clearTimeout(reverseProxyDebounceRef.current);
          reverseProxyDebounceRef.current = null;
      }
      if (reversedClipIds.size === 0) return;

      reverseProxyDebounceRef.current = window.setTimeout(() => {
          reversedClipIds.forEach((clipId) => {
              const clip = clips.find(c => c.id === clipId);
              if (clip && !clip.reverseProxyPath) {
                  void startReverseProxyGeneration(clip);
              }
          });
      }, 600);

      return () => {
          if (reverseProxyDebounceRef.current) {
              window.clearTimeout(reverseProxyDebounceRef.current);
              reverseProxyDebounceRef.current = null;
          }
      };
  }, [clips, tracks]);

  const handleRemoveSegment = (id: string) => {
      let nextSelectionId: string | null = null;
      if (selectedSegmentId === id) {
          const trackWithTarget = tracks.find(t => t.segments.some(s => s.id === id));
          if (trackWithTarget) {
              const orderedSegments = [...trackWithTarget.segments].sort(
                  (a, b) => a.timelineStart - b.timelineStart
              );
              const targetIndex = orderedSegments.findIndex(segment => segment.id === id);
              if (targetIndex >= 0) {
                  nextSelectionId = orderedSegments[targetIndex + 1]?.id ?? null;
              }
          }
      }
      setTracks(prev => prev.map(t => {
          const target = t.segments.find(s => s.id === id);
          if (!target) {
              return { ...t, segments: t.segments.filter(s => s.id !== id) };
          }
          const orderedSegments = [...t.segments].sort((a, b) => a.timelineStart - b.timelineStart);
          const orderById = new Map(orderedSegments.map((segment, index) => [segment.id, index]));
          const targetIndex = orderById.get(id) ?? -1;
          const nextSegments = t.segments
              .filter(s => s.id !== id)
              .map(s => {
                  if (targetIndex >= 0 && (orderById.get(s.id) ?? -1) > targetIndex) {
                      return { ...s, timelineStart: s.timelineStart - target.duration };
                  }
                  return s;
              });
          return { ...t, segments: nextSegments };
      }));
      if (selectedSegmentId === id) {
          setSelectedSegmentId(nextSelectionId);
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
      setSelectedMediaClipId(null);
  };

  const handleSelectMediaClip = (id: string) => {
      setSelectedMediaClipId(id);
      setSelectedSegmentId(null);
      setSwapMode(false);
      setSwapSourceId(null);
  };

  const handleAddClipToTimeline = (clipId: string) => {
      const clip = clips.find(c => c.id === clipId);
      if (!clip || clip.type !== 'video') return;
      const nextVideoClipId = (() => {
          const currentIndex = clips.findIndex(c => c.id === clipId);
          if (currentIndex === -1) return null;
          const nextClip = clips.slice(currentIndex + 1).find(c => c.type === 'video');
          return nextClip ? nextClip.id : null;
      })();
      const barLengthSec = (60 / beatGrid.bpm) * BEATS_PER_BAR;
      const barDurationMs = Number.isFinite(barLengthSec) ? barLengthSec * 1000 : 0;
      const requestedBars = Number.isFinite(mediaClipBars) ? mediaClipBars : 4;
      const clampedBars = Math.min(16, Math.max(0.25, requestedBars));
      const desiredDuration = barDurationMs > 0 ? clampedBars * barDurationMs : clip.duration;
      const durationMs = Math.min(clip.duration, Math.max(1, desiredDuration));
      const introSkipMs = Math.max(0, introSkipFrames) / DEFAULT_FPS * 1000;
      const segmentId = uuidv4();

      setTracks(prev => prev.map(t => {
          if (t.type !== 'video') return t;
          const lastEnd = t.segments.reduce((max, seg) => Math.max(max, seg.timelineStart + seg.duration), 0);
          const timelineStart = t.segments.length > 0 ? lastEnd : introSkipMs;
          const nextSegment: ClipSegment = {
              id: segmentId,
              sourceClipId: clip.id,
              timelineStart,
              duration: durationMs,
              sourceStartOffset: 0,
              playbackRate: 1,
              reverse: false,
              fadeIn: { ...defaultFadeIn },
              fadeOut: { ...defaultFadeOut }
          };
          return { ...t, segments: [...t.segments, nextSegment] };
      }));

      if (nextVideoClipId) {
          setSelectedMediaClipId(nextVideoClipId);
          setSelectedSegmentId(null);
          setSwapMode(false);
          setSwapSourceId(null);
      } else {
          setSelectedSegmentId(segmentId);
          setSelectedMediaClipId(null);
      }
  };

  const openAutoSyncDialog = () => {
      setAutoSyncBpm(Number.isFinite(beatGrid.bpm) ? beatGrid.bpm : 120);
      setAutoSyncIntroSkipFrames(introSkipFrames);
      setAutoSyncError(null);
      setAutoSyncOpen(true);
      setOptionsOpen(false);
  };

  const closeAutoSyncDialog = () => {
      setAutoSyncOpen(false);
      setAutoSyncError(null);
  };

  const openExportDialog = () => {
      setExportProgress(0);
      setExportError(null);
      setExportOpen(true);
      setOptionsOpen(false);
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

      const apiKey = geminiApiKey.trim();
      if (!apiKey) {
          setAutoSyncError('Add a Gemini API key in Options before running analysis.');
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
          let payload: any;
          if (window.electronAPI?.geminiAnalyze) {
              const result = await window.electronAPI.geminiAnalyze({
                  apiKey,
                  model,
                  prompt,
                  mimeType,
                  base64Data
              });
              if (!result.ok) {
                  throw new Error(result.error || `Gemini request failed (${result.status})`);
              }
              payload = result.payload;
          } else {
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

              payload = await response.json();
          }
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
    const introSkipSec = Math.min(0, introSkipFrames) / DEFAULT_FPS;
    const startAudioAt = (timelineMs: number) => {
        if (!masterAudioBufferRef.current) return;
        if (audioSourceNodeRef.current) {
            try { audioSourceNodeRef.current.stop(); } catch(e){}
        }
        const source = ctx.createBufferSource();
        source.buffer = masterAudioBufferRef.current;
        source.connect(ctx.destination);
        const maxOffset = Math.max(0, source.buffer.duration - 0.05);
        const offsetSec = Math.min(Math.max(0, timelineMs / 1000 - introSkipSec), maxOffset);
        source.start(0, offsetSec);
        audioSourceNodeRef.current = source;
    };

    // Start audio if we have a master track
    if (masterAudioBufferRef.current) {
        startAudioAt(playbackState.currentTime);
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
                startAudioAt(0);
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
      const introSkipSec = Math.min(0, introSkipFrames) / DEFAULT_FPS;
      const offsetSec = Math.min(Math.max(0, timeMs / 1000 - introSkipSec), maxOffset);
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
              return t;
          }

          const nextDuration = updates.duration ?? target.duration;
          const delta = nextDuration - target.duration;
          const orderedSegments = [...t.segments].sort((a, b) => a.timelineStart - b.timelineStart);
          const orderById = new Map(orderedSegments.map((segment, index) => [segment.id, index]));
          const targetIndex = orderById.get(id) ?? -1;
          const shiftedSegments = t.segments.map(s => {
              if (s.id === id) {
                  return { ...s, ...updates, duration: nextDuration };
              }
              if (delta !== 0 && targetIndex >= 0 && (orderById.get(s.id) ?? -1) > targetIndex) {
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
      const clampedFrames = Math.round(nextFrames);
      const deltaFrames = clampedFrames - introSkipFrames;
      if (deltaFrames === 0) {
          setIntroSkipFrames(clampedFrames);
          return;
      }
      const deltaSec = deltaFrames / DEFAULT_FPS;
      setBeatGrid(prev => {
          const shiftedBeats = prev.beats.map(beat => Math.max(0, beat + deltaSec));
          return {
              ...prev,
              offset: prev.offset + deltaSec,
              beats: [...new Set(shiftedBeats)].sort((a, b) => a - b)
          };
      });
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
      const exportTimestamp = Math.floor(Date.now() / 1000);
      const primaryAudioForExport = getPrimaryAudioClip(clips);
      const inputMap = new Map<string, { index: number; name: string }>();
      let inputIndex = 0;

      let didSucceed = false;
      let unsubscribeProgress: (() => void) | null = null;
      const jobId = uuidv4();
      try {
          const formatSec = (value: number) => value.toFixed(6);
          const frameRate = DEFAULT_FPS;
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
          let lastEndSec = 0;
          const debugSegments: Array<Record<string, number | string | boolean>> = [];
          sortedSegments.forEach((segment, idx) => {
              const input = inputMap.get(segment.sourceClipId);
              if (!input) return;
              const clip = clips.find(c => c.id === segment.sourceClipId);
              if (!clip) return;
              const segmentDurationMs = Math.max(1, segment.duration);
              const segmentDurationSec = segmentDurationMs / 1000;
              const segmentStartSec = segment.timelineStart / 1000;
              const gapSec = Math.max(0, segmentStartSec - lastEndSec);
              const startSec = segment.sourceStartOffset / 1000;
              const requestedRate = typeof segment.playbackRate === 'number' && Number.isFinite(segment.playbackRate)
                  ? Math.max(0.05, segment.playbackRate)
                  : 1;
              const availableDuration = Math.max(0, clip.duration - segment.sourceStartOffset);
              const maxRate = availableDuration > 0 && segmentDurationMs > 0
                  ? availableDuration / segmentDurationMs
                  : requestedRate;
              const effectiveRate = Math.min(requestedRate, maxRate);
              const speedRate = Number.isFinite(effectiveRate) && effectiveRate > 0 ? effectiveRate : 1;
              const speedFactor = 1 / speedRate;
              const durationSec = Math.max(0.001, (segmentDurationMs * speedRate) / 1000);
              const fadeFilters: string[] = [];
              const fadeIn = segment.fadeIn ?? defaultFadeIn;
              if (fadeIn.enabled) {
                  const start = Math.max(0, fadeIn.startMs);
                  const end = Math.max(start, fadeIn.endMs);
                  const durationMs = end - start;
                  const stSec = (durationMs > 0 ? start : end) / 1000;
                  const dSec = Math.max(durationMs / 1000, 0.001);
                  fadeFilters.push(`fade=t=in:st=${formatSec(stSec)}:d=${formatSec(dSec)}`);
              }
              const fadeOut = segment.fadeOut ?? defaultFadeOut;
              if (fadeOut.enabled) {
                  const startRaw = segmentDurationMs + fadeOut.startMs;
                  const endRaw = segmentDurationMs + fadeOut.endMs;
                  const clampedStart = Math.max(0, Math.min(segmentDurationMs, startRaw));
                  const clampedEnd = Math.max(0, Math.min(segmentDurationMs, endRaw));
                  const start = Math.min(clampedStart, clampedEnd);
                  const end = Math.max(clampedStart, clampedEnd);
                  const durationMs = end - start;
                  const stSec = (durationMs > 0 ? start : end) / 1000;
                  const dSec = Math.max(durationMs / 1000, 0.001);
                  fadeFilters.push(`fade=t=out:st=${formatSec(stSec)}:d=${formatSec(dSec)}`);
              }
              const filterChain = [
                  `trim=start=${formatSec(startSec)}:duration=${formatSec(durationSec)}`
              ];
              if (segment.reverse) {
                  filterChain.push('reverse');
              }
              filterChain.push(`setpts=(PTS-STARTPTS)*${speedFactor.toFixed(6)}`);
              const fadeSuffix = fadeFilters.length > 0 ? `,${fadeFilters.join(',')}` : '';
              const gapSuffix = gapSec > 0
                  ? `,tpad=start_duration=${formatSec(gapSec)}:start_mode=add:color=black`
                  : '';
              filterParts.push(
                  `[${input.index}:v]${filterChain.join(',')},scale=${targetWidth}:${targetHeight}:flags=fast_bilinear` +
                  `${fadeSuffix}${gapSuffix}[v${idx}]`
              );
              concatInputs.push(`[v${idx}]`);
              lastEndSec = segmentStartSec + segmentDurationSec;
              debugSegments.push({
                  idx,
                  clipId: clip.id,
                  clipName: clip.name,
                  timelineStartSec: Number(segmentStartSec.toFixed(6)),
                  segmentDurationSec: Number(segmentDurationSec.toFixed(6)),
                  gapSec: Number(gapSec.toFixed(6)),
                  sourceStartSec: Number(startSec.toFixed(6)),
                  playbackRate: Number(speedRate.toFixed(6)),
                  reverse: Boolean(segment.reverse),
              });
          });
          if (concatInputs.length === 0) {
              setExportError('No valid video segments to export. Check that clips still exist.');
              return;
          }

          const firstClipId = sortedSegments.find(segment => inputMap.has(segment.sourceClipId))?.sourceClipId;
          const firstClipPath = firstClipId ? inputMap.get(firstClipId)?.name ?? '' : '';
          const audioExportPath = primaryAudioForExport?.filePath ?? '';
          const canUseAudioPath = audioExportPath && !audioExportPath.startsWith('blob:') && !audioExportPath.startsWith('data:');
          const outputBaseStem = canUseAudioPath
              ? stripExtension(getBaseName(audioExportPath)) || 'beatcutter-export'
              : 'beatcutter-export';
          const outputDir = canUseAudioPath
              ? getDirName(audioExportPath)
              : (firstClipPath ? getDirName(firstClipPath) : '');
          if (!outputDir) {
              setExportError('Unable to resolve output folder for export.');
              return;
          }
          const outputFileName = `${outputBaseStem} - ${exportTimestamp}.mp4`;
          const outputPath = joinPath(outputDir, outputFileName);

          const outputDurationSec = lastEndSec;
          const audioOffsetSec = Math.min(0, introSkipFrames) / DEFAULT_FPS;
          const audioDelayMs = audioOffsetSec < 0 ? Math.round(-audioOffsetSec * 1000) : 0;
          const isNearlyInteger = (value: number, epsilon = 1e-3) =>
              Math.abs(value - Math.round(value)) <= epsilon;
          const frameAligned = sortedSegments.every((segment) =>
              isNearlyInteger((segment.timelineStart / 1000) * frameRate) &&
              isNearlyInteger((segment.duration / 1000) * frameRate)
          );
          const outputDurationFixedSec = outputDurationSec > 0
              ? Math.round(outputDurationSec * frameRate) / frameRate
              : 0;
          const useCfrExport = frameAligned;
          const outputDurationTargetSec = useCfrExport ? outputDurationFixedSec : outputDurationSec;
          const audioFilter = audioInputIndex !== null && outputDurationSec > 0
              ? (() => {
                  const filters: string[] = [];
                  if (audioDelayMs > 0) {
                      filters.push(`adelay=${audioDelayMs}:all=1`);
                  }
                  filters.push('apad');
                  filters.push(`atrim=0:${formatSec(outputDurationTargetSec)}`);
                  filters.push('asetpts=PTS-STARTPTS');
                  return `;[${audioInputIndex}:a]${filters.join(',')}[outa]`;
              })()
              : '';
          const videoPostFilter = outputDurationTargetSec > 0
              ? useCfrExport
                  ? `;[outvraw]fps=${DEFAULT_FPS},trim=duration=${formatSec(outputDurationTargetSec)}[outv]`
                  : `;[outvraw]trim=duration=${formatSec(outputDurationTargetSec)}[outv]`
              : useCfrExport
                  ? `;[outvraw]fps=${DEFAULT_FPS}[outv]`
                  : `;[outvraw]setpts=PTS-STARTPTS[outv]`;
          const filterComplex = `${filterParts.join(';')};${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0[outvraw]` +
              `${videoPostFilter}${audioFilter}`;
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
              ...(useCfrExport ? ['-vsync', 'cfr', '-r', `${DEFAULT_FPS}`] : ['-vsync', 'vfr']),
              '-b:v', `${Math.max(1, safeMbps).toFixed(0)}M`,
              '-pix_fmt', 'yuv420p',
              '-profile:v', 'high',
              '-level:v', '5.1',
              '-c:a', 'aac',
              '-movflags', '+faststart',
              outputPath
          );

          console.info('Export debug', {
              jobId,
              outputPath,
              outputDurationSec: Number(outputDurationSec.toFixed(6)),
              outputDurationFixedSec: Number(outputDurationFixedSec.toFixed(6)),
              outputDurationTargetSec: Number(outputDurationTargetSec.toFixed(6)),
              audioOffsetSec: Number(audioOffsetSec.toFixed(6)),
              audioDelayMs,
              targetWidth,
              targetHeight,
              useCfrExport,
              frameAligned,
              segmentCount: concatInputs.length,
              segments: debugSegments,
              filterComplex,
              args,
          });

          unsubscribeProgress = onFfmpegProgress((progress) => {
              if (progress.jobId !== jobId) return;
              if (!Number.isFinite(progress.progress)) return;
              setExportProgress(Math.min(100, Math.round(progress.progress)));
          });

          const execResult = await runFfmpeg({ jobId, args, durationSec: outputDurationTargetSec });
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

  const canSaveProject = Boolean(window.electronAPI?.project?.save) && clips.some(c => c.type === 'audio');
  const canLoadLastProject = Boolean(window.electronAPI?.project?.load) && Boolean(lastProjectPath);

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
            useProxies={useProxies}
            canToggleProxies={Boolean(window.electronAPI?.proxy?.run)}
            onToggleProxies={() => setUseProxies(prev => !prev)}
            optionsOpen={optionsOpen}
            onToggleOptions={() => setOptionsOpen(prev => !prev)}
            geminiApiKey={geminiApiKey}
            onGeminiApiKeyChange={setGeminiApiKey}
            projectName={projectName}
            onSaveProject={handleSaveProject}
            onLoadLastProject={handleLoadLastProject}
            onNewProject={handleNewProject}
            canSaveProject={canSaveProject}
            canLoadLastProject={canLoadLastProject}
            projectIoStatus={projectIoStatus}
        />

        <div className="flex flex-1 overflow-hidden">
            {/* Left: Media Pool */}
            <MediaPool
                clips={clips}
                onImport={handleImport}
                onDelete={handleDeleteClip}
                selectedClipId={selectedMediaClipId}
                onSelectClip={handleSelectMediaClip}
            />

            {/* Center: Preview Stage */}
            <div className="flex-1 flex flex-col bg-stone-950 relative min-w-0">
                <div className="flex-1 p-4 flex items-stretch justify-stretch">
                    <div className="w-full h-full bg-stone-900 shadow-2xl rounded-lg overflow-hidden border border-stone-800">
                        <PreviewPlayer 
                            playbackState={playbackState} 
                            videoTrack={tracks.find(t => t.type === 'video')}
                            clips={clips}
                            getClipUrl={resolvePreviewUrl}
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
                    onZoomChange={handleZoomChange}
                    onSelectSegment={handleSelectSegment}
                    selectedSegmentId={selectedSegmentId}
                />
            </div>

            {/* Right: Inspector */}
            <Inspector 
                selectedSegmentId={selectedSegmentId}
                selectedMediaClipId={selectedMediaClipId}
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
                mediaClipBars={mediaClipBars}
                onUpdateMediaClipBars={setMediaClipBars}
                onAddClipToTimeline={handleAddClipToTimeline}
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
