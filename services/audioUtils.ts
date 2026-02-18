import * as ort from 'onnxruntime-web';
import { BeatGrid } from '../types';

const DEFAULT_BPM = 120;
const TARGET_SAMPLE_RATE = 22050;
const FFT_SIZE = 1024;
const HOP_SIZE = 441;
const FRAMES_PER_SECOND = TARGET_SAMPLE_RATE / HOP_SIZE;
const MEL_BINS = 128;
const MEL_FMIN_HZ = 30;
const MEL_FMAX_HZ = 11000;
const LOG_MAG_SCALE = 1000;
const MAX_CHUNK_SECONDS = 30;
const MIN_PEAK_PROBABILITY = 0.2;
const MIN_BEAT_GAP_SECONDS = 0.08;
const MIN_INTERVAL_SECONDS = 60 / 240;
const MAX_INTERVAL_SECONDS = 60 / 40;
const MODEL_RELATIVE_PATH = 'models/beatthis-small0.onnx';

let beatThisSessionPromise: Promise<ort.InferenceSession> | null = null;
let hannWindowCache: Float32Array | null = null;
let melFilterbankCache: Float32Array | null = null;

const getModelUrl = (): string => {
  const base = (import.meta as any).env?.BASE_URL ?? '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${MODEL_RELATIVE_PATH}`;
};

const toMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const toHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1);

const getHannWindow = (): Float32Array => {
  if (hannWindowCache) return hannWindowCache;
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  hannWindowCache = window;
  return hannWindowCache;
};

const getMelFilterbank = (): Float32Array => {
  if (melFilterbankCache) return melFilterbankCache;

  const bins = FFT_SIZE / 2 + 1;
  const filterbank = new Float32Array(MEL_BINS * bins);
  const clampedMaxHz = Math.min(MEL_FMAX_HZ, (TARGET_SAMPLE_RATE / 2) - 1);
  const melMin = toMel(MEL_FMIN_HZ);
  const melMax = toMel(clampedMaxHz);
  const melPoints = new Float32Array(MEL_BINS + 2);
  const fftBins = new Int32Array(MEL_BINS + 2);

  for (let i = 0; i < melPoints.length; i++) {
    melPoints[i] = melMin + ((melMax - melMin) * i) / (MEL_BINS + 1);
    const hz = toHz(melPoints[i]);
    const mapped = Math.floor(((FFT_SIZE + 1) * hz) / TARGET_SAMPLE_RATE);
    fftBins[i] = Math.max(0, Math.min(bins - 1, mapped));
  }

  for (let band = 1; band <= MEL_BINS; band++) {
    const left = fftBins[band - 1];
    const center = fftBins[band];
    const right = fftBins[band + 1];
    if (center <= left || right <= center) continue;

    const offset = (band - 1) * bins;
    for (let k = left; k < center; k++) {
      filterbank[offset + k] = (k - left) / (center - left);
    }
    for (let k = center; k <= right; k++) {
      filterbank[offset + k] = (right - k) / (right - center);
    }

    let sum = 0;
    for (let k = 0; k < bins; k++) {
      sum += filterbank[offset + k];
    }
    if (sum > 0) {
      for (let k = 0; k < bins; k++) {
        filterbank[offset + k] /= sum;
      }
    }
  }

  melFilterbankCache = filterbank;
  return melFilterbankCache;
};

const mixToMono = (buffer: AudioBuffer): Float32Array => {
  const channelCount = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);

  if (channelCount === 1) {
    mono.set(buffer.getChannelData(0));
    return mono;
  }

  for (let ch = 0; ch < channelCount; ch++) {
    const channel = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channel[i];
    }
  }
  const invChannels = 1 / channelCount;
  for (let i = 0; i < length; i++) {
    mono[i] *= invChannels;
  }
  return mono;
};

const resampleLinear = (
  input: Float32Array,
  sourceRate: number,
  targetRate: number
): Float32Array => {
  if (sourceRate === targetRate) {
    return input.slice();
  }
  if (input.length === 0) {
    return new Float32Array(0);
  }

  const ratio = sourceRate / targetRate;
  const targetLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Float32Array(targetLength);

  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, input.length - 1);
    const frac = sourceIndex - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return output;
};

const fftInPlace = (real: Float32Array, imag: Float32Array): void => {
  const n = real.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = (-2 * Math.PI) / len;
    for (let start = 0; start < n; start += len) {
      for (let i = 0; i < half; i++) {
        const angle = i * angleStep;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const even = start + i;
        const odd = even + half;
        const tReal = real[odd] * cos - imag[odd] * sin;
        const tImag = real[odd] * sin + imag[odd] * cos;
        real[odd] = real[even] - tReal;
        imag[odd] = imag[even] - tImag;
        real[even] += tReal;
        imag[even] += tImag;
      }
    }
  }
};

const computeLogMelSpectrogram = (
  audio: Float32Array
): { data: Float32Array; frameCount: number } => {
  if (audio.length === 0) {
    return { data: new Float32Array(0), frameCount: 0 };
  }

  const frameCount = audio.length <= FFT_SIZE
    ? 1
    : 1 + Math.floor((audio.length - FFT_SIZE) / HOP_SIZE);

  const bins = FFT_SIZE / 2 + 1;
  const melFilters = getMelFilterbank();
  const window = getHannWindow();
  const logMel = new Float32Array(frameCount * MEL_BINS);
  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const power = new Float32Array(bins);

  for (let frame = 0; frame < frameCount; frame++) {
    real.fill(0);
    imag.fill(0);
    const frameOffset = frame * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const index = frameOffset + i;
      real[i] = (index < audio.length ? audio[index] : 0) * window[i];
    }

    fftInPlace(real, imag);

    for (let k = 0; k < bins; k++) {
      power[k] = real[k] * real[k] + imag[k] * imag[k];
    }

    const outOffset = frame * MEL_BINS;
    for (let mel = 0; mel < MEL_BINS; mel++) {
      const melOffset = mel * bins;
      let weightedSum = 0;
      for (let k = 0; k < bins; k++) {
        weightedSum += power[k] * melFilters[melOffset + k];
      }
      // BeatThis expects ln(1 + 1000 * mel_power).
      logMel[outOffset + mel] = Math.log1p(LOG_MAG_SCALE * weightedSum);
    }
  }

  return { data: logMel, frameCount };
};

const transposeTimeMajorToMelMajor = (
  timeMajor: Float32Array,
  frameCount: number
): Float32Array => {
  const melMajor = new Float32Array(frameCount * MEL_BINS);
  for (let frame = 0; frame < frameCount; frame++) {
    const srcOffset = frame * MEL_BINS;
    for (let mel = 0; mel < MEL_BINS; mel++) {
      melMajor[mel * frameCount + frame] = timeMajor[srcOffset + mel];
    }
  }
  return melMajor;
};

const createInputTensor = (
  session: ort.InferenceSession,
  logMel: Float32Array,
  frameCount: number
): ort.Tensor => {
  const inputName = session.inputNames[0];
  const metadata = session.inputMetadata[inputName];
  const dims = metadata?.dimensions ?? [];
  const rank = dims.length || 3;
  const dimMatches = (index: number, value: number) =>
    typeof dims[index] === 'number' && dims[index] === value;

  if (rank === 2) {
    if (dimMatches(0, MEL_BINS)) {
      const melMajor = transposeTimeMajorToMelMajor(logMel, frameCount);
      return new ort.Tensor('float32', melMajor, [MEL_BINS, frameCount]);
    }
    return new ort.Tensor('float32', logMel, [frameCount, MEL_BINS]);
  }

  if (rank === 4) {
    if (dimMatches(2, MEL_BINS)) {
      const melMajor = transposeTimeMajorToMelMajor(logMel, frameCount);
      return new ort.Tensor('float32', melMajor, [1, 1, MEL_BINS, frameCount]);
    }
    return new ort.Tensor('float32', logMel, [1, 1, frameCount, MEL_BINS]);
  }

  if (dimMatches(1, MEL_BINS)) {
    const melMajor = transposeTimeMajorToMelMajor(logMel, frameCount);
    return new ort.Tensor('float32', melMajor, [1, MEL_BINS, frameCount]);
  }
  return new ort.Tensor('float32', logMel, [1, frameCount, MEL_BINS]);
};

const extractVector = (tensor: ort.Tensor, expectedLength: number): Float32Array => {
  const data = tensor.data as Float32Array;
  const dims = tensor.dims;

  if (dims.length === 1) {
    return data.length === expectedLength
      ? data.slice()
      : data.slice(0, Math.min(data.length, expectedLength));
  }

  if (dims.length === 2) {
    if (dims[1] === 1) {
      const out = new Float32Array(Math.min(dims[0], expectedLength));
      for (let i = 0; i < out.length; i++) out[i] = data[i];
      return out;
    }
    if (dims[0] === 1) {
      return data.slice(0, Math.min(dims[1], expectedLength));
    }
  }

  if (data.length >= expectedLength) {
    return data.slice(0, expectedLength);
  }

  const padded = new Float32Array(expectedLength);
  padded.set(data.slice(0, expectedLength));
  return padded;
};

const extractBeatProbabilities = (tensor: ort.Tensor, expectedFrames: number): Float32Array => {
  const data = tensor.data as Float32Array;
  const dims = tensor.dims;

  if (dims.length === 3) {
    const [d0, d1, d2] = dims;
    if (d2 === 2) {
      const frames = Math.min(d1, expectedFrames);
      const out = new Float32Array(frames);
      for (let t = 0; t < frames; t++) out[t] = data[t * 2];
      return out;
    }
    if (d1 === 2) {
      const frames = Math.min(d2, expectedFrames);
      const out = new Float32Array(frames);
      for (let t = 0; t < frames; t++) out[t] = data[t];
      return out;
    }
    if (d0 === 2) {
      const frames = Math.min(d1 * d2, expectedFrames);
      return data.slice(0, frames);
    }
  }

  if (dims.length === 2) {
    const [d0, d1] = dims;
    if (d1 === 2) {
      const frames = Math.min(d0, expectedFrames);
      const out = new Float32Array(frames);
      for (let t = 0; t < frames; t++) out[t] = data[t * 2];
      return out;
    }
    if (d0 === 2) {
      const frames = Math.min(d1, expectedFrames);
      return data.slice(0, frames);
    }
  }

  if (data.length === expectedFrames * 2) {
    const out = new Float32Array(expectedFrames);
    for (let t = 0; t < expectedFrames; t++) out[t] = data[t * 2];
    return out;
  }

  if (data.length >= expectedFrames) {
    return data.slice(0, expectedFrames);
  }

  const padded = new Float32Array(expectedFrames);
  padded.set(data);
  return padded;
};

const loadBeatThisSession = async (): Promise<ort.InferenceSession> => {
  if (!beatThisSessionPromise) {
    beatThisSessionPromise = (async () => {
      if (ort.env?.wasm) {
        ort.env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1));
      }

      const modelUrl = getModelUrl();
      try {
        return await ort.InferenceSession.create(modelUrl, {
          executionProviders: ['webgpu', 'wasm'],
          graphOptimizationLevel: 'all'
        });
      } catch {
        return await ort.InferenceSession.create(modelUrl, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
      }
    })();
  }
  return beatThisSessionPromise;
};

const inferBeatProbabilities = async (
  logMel: Float32Array,
  frameCount: number
): Promise<Float32Array> => {
  const session = await loadBeatThisSession();
  const inputName = session.inputNames[0];
  const inputTensor = createInputTensor(session, logMel, frameCount);
  const outputs = await session.run({ [inputName]: inputTensor });

  const outputNames = session.outputNames;
  const beatOutputName = outputNames.find((name) => {
    const key = name.toLowerCase();
    return key.includes('beat') && !key.includes('down');
  });

  if (beatOutputName && outputs[beatOutputName]) {
    return extractVector(outputs[beatOutputName], frameCount);
  }

  if (outputNames.length >= 2) {
    const first = outputs[outputNames[0]];
    if (first) return extractVector(first, frameCount);
  }

  const firstOutput = outputs[outputNames[0]];
  if (!firstOutput) {
    throw new Error('BeatThis model did not return outputs.');
  }
  return extractBeatProbabilities(firstOutput, frameCount);
};

const smoothProbabilities = (values: Float32Array, radius = 2): Float32Array => {
  if (values.length === 0) return new Float32Array(0);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += values[j];
    out[i] = sum / (end - start + 1);
  }
  return out;
};

const pickPeakFrames = (
  series: Float32Array,
  threshold: number,
  minDistanceFrames: number
): number[] => {
  if (series.length < 3) return [];
  const peaks: number[] = [];
  const strengths: number[] = [];

  for (let i = 1; i < series.length - 1; i++) {
    const value = series[i];
    if (value < threshold) continue;
    if (value < series[i - 1] || value <= series[i + 1]) continue;

    const lastIndex = peaks.length > 0 ? peaks[peaks.length - 1] : -Infinity;
    if (i - lastIndex >= minDistanceFrames) {
      peaks.push(i);
      strengths.push(value);
      continue;
    }

    const previousStrength = strengths[strengths.length - 1];
    if (value > previousStrength) {
      peaks[peaks.length - 1] = i;
      strengths[strengths.length - 1] = value;
    }
  }

  return peaks;
};

const detectBeatTimes = (beatProbabilities: Float32Array, chunkStartSeconds: number): number[] => {
  if (beatProbabilities.length === 0) return [];

  const smoothed = smoothProbabilities(beatProbabilities, 2);
  let mean = 0;
  for (let i = 0; i < smoothed.length; i++) mean += smoothed[i];
  mean /= smoothed.length;

  let variance = 0;
  for (let i = 0; i < smoothed.length; i++) {
    const delta = smoothed[i] - mean;
    variance += delta * delta;
  }
  variance /= smoothed.length;
  const stdDev = Math.sqrt(variance);
  const dynamicThreshold = Math.max(MIN_PEAK_PROBABILITY, mean + stdDev * 0.35);
  const minDistance = Math.max(1, Math.round((60 / 240) * FRAMES_PER_SECOND));

  let frames = pickPeakFrames(smoothed, dynamicThreshold, minDistance);
  if (frames.length < 2) {
    const relaxed = Math.max(MIN_PEAK_PROBABILITY * 0.6, dynamicThreshold * 0.75);
    frames = pickPeakFrames(smoothed, relaxed, Math.max(1, Math.floor(minDistance / 2)));
  }

  return frames.map((frame) => chunkStartSeconds + frame / FRAMES_PER_SECOND);
};

const dedupeTimes = (times: number[], minGapSeconds: number): number[] => {
  if (times.length === 0) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const unique: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - unique[unique.length - 1] >= minGapSeconds) {
      unique.push(sorted[i]);
    }
  }
  return unique;
};

const median = (values: number[]): number => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

const estimateBpm = (beatTimes: number[]): number => {
  if (beatTimes.length < 2) return DEFAULT_BPM;
  const intervals: number[] = [];
  for (let i = 1; i < beatTimes.length; i++) {
    const interval = beatTimes[i] - beatTimes[i - 1];
    if (interval >= MIN_INTERVAL_SECONDS && interval <= MAX_INTERVAL_SECONDS) {
      intervals.push(interval);
    }
  }

  if (intervals.length === 0) return DEFAULT_BPM;

  const med = median(intervals);
  if (!Number.isFinite(med) || med <= 0) return DEFAULT_BPM;
  let bpm = 60 / med;
  while (bpm < 60) bpm *= 2;
  while (bpm > 200) bpm /= 2;
  return Number(bpm.toFixed(2));
};

const yieldToMainThread = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Decodes an audio file and returns the AudioBuffer
 */
export const decodeAudio = async (fileUrl: string): Promise<AudioBuffer> => {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to load audio (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  return await audioContext.decodeAudioData(arrayBuffer);
};

/**
 * BeatThis-based beat tracking using ONNX Runtime Web.
 */
export const analyzeBeats = async (buffer: AudioBuffer): Promise<BeatGrid> => {
  try {
    const mono = mixToMono(buffer);
    const resampled = resampleLinear(mono, buffer.sampleRate, TARGET_SAMPLE_RATE);
    if (resampled.length === 0) {
      return buildBeatGrid(DEFAULT_BPM, 0, buffer.duration);
    }

    const beats: number[] = [];
    const chunkSize = Math.floor(MAX_CHUNK_SECONDS * TARGET_SAMPLE_RATE);
    for (let chunkStart = 0; chunkStart < resampled.length; chunkStart += chunkSize) {
      const chunkEnd = Math.min(resampled.length, chunkStart + chunkSize);
      const chunk = resampled.subarray(chunkStart, chunkEnd);
      const { data, frameCount } = computeLogMelSpectrogram(chunk);
      if (frameCount === 0) continue;

      const probs = await inferBeatProbabilities(data, frameCount);
      const chunkStartSec = chunkStart / TARGET_SAMPLE_RATE;
      beats.push(...detectBeatTimes(probs, chunkStartSec));
      await yieldToMainThread();
    }

    const deduped = dedupeTimes(
      beats
        .filter((time) => Number.isFinite(time) && time >= 0 && time <= (buffer.duration + 0.1)),
      MIN_BEAT_GAP_SECONDS
    );

    if (deduped.length === 0) {
      return buildBeatGrid(DEFAULT_BPM, 0, buffer.duration);
    }

    return {
      bpm: estimateBpm(deduped),
      offset: deduped[0],
      beats: deduped
    };
  } catch (error) {
    console.warn('BeatThis analysis failed. Falling back to default beat grid.', error);
    return buildBeatGrid(DEFAULT_BPM, 0, buffer.duration);
  }
};

export const buildBeatGrid = (bpm: number, offset: number, durationSec: number): BeatGrid => {
  const cleanBeats: number[] = [];
  const spb = 60 / bpm;

  const start = Number.isFinite(offset) ? offset : 0;
  let t = start;
  while (t > 0) {
    t -= spb;
  }

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
    offset: start,
    beats: uniqueBeats
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
    // Optimization: don't check every sample, check a subset.
    for (let j = 0; j < step; j += 100) {
      if (start + j < channelData.length) {
        const val = Math.abs(channelData[start + j]);
        if (val > max) max = val;
      }
    }
    waveform.push(max);
  }
  return waveform;
};
