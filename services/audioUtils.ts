import * as ort from 'onnxruntime-web';
import ortWasmJsepMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasmJsepWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
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
const INFERENCE_CHUNK_SIZE_FRAMES = 1500;
const INFERENCE_BORDER_SIZE_FRAMES = 6;
const BPM_MIN = 60;
const BPM_MAX = 200;
const BPM_BIN_WIDTH = 0.1;
const MAX_IOI_BEATS = 8;
const PEAK_MAXPOOL_WIDTH = 7;
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

// Match torchaudio/librosa Slaney mel scale used by BeatThis preprocessing.
const toMelSlaney = (hz: number): number => {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  if (hz < minLogHz) return hz / fSp;
  return minLogMel + Math.log(hz / minLogHz) / logStep;
};

const toHzSlaney = (mel: number): number => {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  if (mel < minLogMel) return mel * fSp;
  return minLogHz * Math.exp(logStep * (mel - minLogMel));
};

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
  const melMin = toMelSlaney(MEL_FMIN_HZ);
  const melMax = toMelSlaney(clampedMaxHz);
  const melPoints = new Float32Array(MEL_BINS + 2);
  const hzPoints = new Float32Array(MEL_BINS + 2);
  const fftBins = new Int32Array(MEL_BINS + 2);

  for (let i = 0; i < melPoints.length; i++) {
    melPoints[i] = melMin + ((melMax - melMin) * i) / (MEL_BINS + 1);
    const hz = toHzSlaney(melPoints[i]);
    hzPoints[i] = hz;
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

    // Slaney area normalization (torchaudio/librosa behavior).
    const hzSpan = hzPoints[band + 1] - hzPoints[band - 1];
    if (hzSpan > 0) {
      const enorm = 2 / hzSpan;
      for (let k = 0; k < bins; k++) {
        filterbank[offset + k] *= enorm;
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

  const reflectIndex = (index: number, length: number): number => {
    if (length <= 1) return 0;
    let idx = index;
    while (idx < 0 || idx >= length) {
      if (idx < 0) {
        idx = -idx;
      } else {
        idx = (2 * length) - 2 - idx;
      }
    }
    return idx;
  };

  // BeatThis uses centered STFT (torchaudio default center=True).
  const pad = FFT_SIZE / 2;
  const frameCount = 1 + Math.floor(audio.length / HOP_SIZE);
  const frameNorm = Math.sqrt(FFT_SIZE);

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
    const frameStart = (frame * HOP_SIZE) - pad;
    for (let i = 0; i < FFT_SIZE; i++) {
      const index = reflectIndex(frameStart + i, audio.length);
      real[i] = audio[index] * window[i];
    }

    fftInPlace(real, imag);

    for (let k = 0; k < bins; k++) {
      const magnitude = Math.sqrt((real[k] * real[k]) + (imag[k] * imag[k])) / frameNorm;
      power[k] = magnitude;
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

type FrameLogits = {
  beat: Float32Array;
  downbeat: Float32Array;
};

const scoreBeatChannel = (logits: Float32Array): number => {
  if (logits.length === 0) return -Infinity;
  const radius = Math.floor(PEAK_MAXPOOL_WIDTH / 2);
  let positiveCount = 0;
  let peakCount = 0;
  for (let i = 0; i < logits.length; i++) {
    const value = logits[i];
    if (value <= 0) continue;
    positiveCount += 1;
    let localMax = -Infinity;
    const start = Math.max(0, i - radius);
    const end = Math.min(logits.length - 1, i + radius);
    for (let j = start; j <= end; j++) {
      if (logits[j] > localMax) localMax = logits[j];
    }
    if (value === localMax) peakCount += 1;
  }
  return peakCount + (positiveCount * 0.25);
};

const selectBeatAndDownbeat = (a: Float32Array, b: Float32Array): FrameLogits => {
  const scoreA = scoreBeatChannel(a);
  const scoreB = scoreBeatChannel(b);
  return scoreA >= scoreB
    ? { beat: a, downbeat: b }
    : { beat: b, downbeat: a };
};

const extractBeatDownbeatFromTensor = (
  tensor: ort.Tensor,
  expectedFrames: number
): FrameLogits => {
  const data = tensor.data as Float32Array;
  const dims = tensor.dims;

  if (dims.length === 3) {
    const [d0, d1, d2] = dims;
    if (d2 === 2) {
      const frames = Math.min(d1, expectedFrames);
      const channel0 = new Float32Array(frames);
      const channel1 = new Float32Array(frames);
      for (let t = 0; t < frames; t++) {
        channel0[t] = data[(t * 2)];
        channel1[t] = data[(t * 2) + 1];
      }
      return selectBeatAndDownbeat(channel0, channel1);
    }
    if (d1 === 2) {
      const frames = Math.min(d2, expectedFrames);
      const channel0 = new Float32Array(frames);
      const channel1 = new Float32Array(frames);
      const frameStride = d2;
      for (let t = 0; t < frames; t++) {
        channel0[t] = data[t];
        channel1[t] = data[frameStride + t];
      }
      return selectBeatAndDownbeat(channel0, channel1);
    }
    if (d0 === 2) {
      const frames = Math.min(d1 * d2, expectedFrames);
      const channel0 = data.slice(0, frames);
      const channel1 = new Float32Array(frames);
      channel1.set(data.slice(frames, frames * 2));
      return selectBeatAndDownbeat(channel0, channel1);
    }
  }

  if (dims.length === 2) {
    const [d0, d1] = dims;
    if (d1 === 2) {
      const frames = Math.min(d0, expectedFrames);
      const channel0 = new Float32Array(frames);
      const channel1 = new Float32Array(frames);
      for (let t = 0; t < frames; t++) {
        channel0[t] = data[(t * 2)];
        channel1[t] = data[(t * 2) + 1];
      }
      return selectBeatAndDownbeat(channel0, channel1);
    }
    if (d0 === 2) {
      const frames = Math.min(d1, expectedFrames);
      return selectBeatAndDownbeat(
        data.slice(0, frames),
        data.slice(frames, frames * 2)
      );
    }
  }

  const beat = extractVector(tensor, expectedFrames);
  return {
    beat,
    downbeat: new Float32Array(beat.length)
  };
};

const loadBeatThisSession = async (): Promise<ort.InferenceSession> => {
  if (!beatThisSessionPromise) {
    beatThisSessionPromise = (async () => {
      if (ort.env?.wasm) {
        // Force explicit wasm asset URLs so Vite/Electron doesn't resolve them to HTML fallback pages.
        (ort.env.wasm as any).wasmPaths = {
          mjs: ortWasmJsepMjsUrl,
          wasm: ortWasmJsepWasmUrl
        };
        const canUseWasmThreads =
          typeof self !== 'undefined' && (self as any).crossOriginIsolated === true;
        ort.env.wasm.numThreads = canUseWasmThreads
          ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
          : 1;
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

const inferFrameLogits = async (
  logMel: Float32Array,
  frameCount: number
): Promise<FrameLogits> => {
  const session = await loadBeatThisSession();
  const inputName = session.inputNames[0];
  const inputTensor = createInputTensor(session, logMel, frameCount);
  const outputs = await session.run({ [inputName]: inputTensor });

  const outputNames = session.outputNames;
  const beatOutputName = outputNames.find((name) => {
    const key = name.toLowerCase();
    return key.includes('beat') && !key.includes('down');
  });
  const downbeatOutputName = outputNames.find((name) => name.toLowerCase().includes('down'));

  if (beatOutputName && outputs[beatOutputName]) {
    const beat = extractVector(outputs[beatOutputName], frameCount);
    const downbeat = downbeatOutputName && outputs[downbeatOutputName]
      ? extractVector(outputs[downbeatOutputName], frameCount)
      : new Float32Array(beat.length);
    return { beat, downbeat };
  }

  if (outputNames.length >= 2) {
    const first = outputs[outputNames[0]];
    const second = outputs[outputNames[1]];
    if (first && second) {
      return selectBeatAndDownbeat(
        extractVector(first, frameCount),
        extractVector(second, frameCount)
      );
    }
  }

  const firstOutput = outputs[outputNames[0]];
  if (!firstOutput) {
    throw new Error('BeatThis model did not return outputs.');
  }
  return extractBeatDownbeatFromTensor(firstOutput, frameCount);
};

const splitPieceStarts = (
  frameCount: number,
  chunkSize: number,
  borderSize: number
): number[] => {
  const starts: number[] = [];
  const step = chunkSize - (2 * borderSize);
  for (let start = -borderSize; start < frameCount - borderSize; start += step) {
    starts.push(start);
  }
  if (frameCount > step && starts.length > 0) {
    starts[starts.length - 1] = frameCount - (chunkSize - borderSize);
  }
  return starts;
};

const extractSpectrogramChunk = (
  spectrogram: Float32Array,
  fullFrames: number,
  startFrame: number,
  chunkSize: number,
  borderSize: number
): { chunk: Float32Array; chunkFrames: number } => {
  const from = Math.max(startFrame, 0);
  const to = Math.min(startFrame + chunkSize, fullFrames);
  const leftPad = Math.max(0, -startFrame);
  const rightPad = Math.max(0, Math.min(borderSize, (startFrame + chunkSize) - fullFrames));
  const sourceFrames = Math.max(0, to - from);
  const chunkFrames = leftPad + sourceFrames + rightPad;

  const chunk = new Float32Array(chunkFrames * MEL_BINS);
  for (let frame = 0; frame < sourceFrames; frame++) {
    const srcOffset = (from + frame) * MEL_BINS;
    const dstOffset = (leftPad + frame) * MEL_BINS;
    chunk.set(spectrogram.subarray(srcOffset, srcOffset + MEL_BINS), dstOffset);
  }
  return { chunk, chunkFrames };
};

const trimBorders = (
  logits: Float32Array,
  borderSize: number
): Float32Array => {
  if (borderSize <= 0 || logits.length <= (2 * borderSize)) {
    return logits.slice();
  }
  return logits.slice(borderSize, logits.length - borderSize);
};

const inferFullTrackFrameLogits = async (
  spectrogram: Float32Array,
  frameCount: number
): Promise<FrameLogits> => {
  const starts = splitPieceStarts(frameCount, INFERENCE_CHUNK_SIZE_FRAMES, INFERENCE_BORDER_SIZE_FRAMES);
  const predBeatChunks: Float32Array[] = [];
  const predDownbeatChunks: Float32Array[] = [];

  for (const start of starts) {
    const { chunk, chunkFrames } = extractSpectrogramChunk(
      spectrogram,
      frameCount,
      start,
      INFERENCE_CHUNK_SIZE_FRAMES,
      INFERENCE_BORDER_SIZE_FRAMES
    );
    const pred = await inferFrameLogits(chunk, chunkFrames);
    predBeatChunks.push(trimBorders(pred.beat, INFERENCE_BORDER_SIZE_FRAMES));
    predDownbeatChunks.push(trimBorders(pred.downbeat, INFERENCE_BORDER_SIZE_FRAMES));
    await yieldToMainThread();
  }

  const beat = new Float32Array(frameCount);
  const downbeat = new Float32Array(frameCount);
  beat.fill(-1000);
  downbeat.fill(-1000);

  // keep_first overlap mode: process in reverse so earlier chunks overwrite later chunks.
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i] + INFERENCE_BORDER_SIZE_FRAMES;
    const beatChunk = predBeatChunks[i];
    const downbeatChunk = predDownbeatChunks[i];

    for (let f = 0; f < beatChunk.length; f++) {
      const target = start + f;
      if (target < 0 || target >= frameCount) continue;
      beat[target] = beatChunk[f];
      if (f < downbeatChunk.length) {
        downbeat[target] = downbeatChunk[f];
      }
    }
  }

  return { beat, downbeat };
};

const deduplicatePeaks = (peaks: number[], width = 1): number[] => {
  if (peaks.length === 0) return [];
  const deduped: number[] = [];
  let currentMean = peaks[0];
  let count = 1;
  for (let i = 1; i < peaks.length; i++) {
    const next = peaks[i];
    if ((next - currentMean) <= width) {
      count += 1;
      currentMean += (next - currentMean) / count;
    } else {
      deduped.push(currentMean);
      currentMean = next;
      count = 1;
    }
  }
  deduped.push(currentMean);
  return deduped;
};

const minimalPostprocessedBeatTimes = (beatLogits: Float32Array): number[] => {
  if (beatLogits.length === 0) return [];
  const radius = Math.floor(PEAK_MAXPOOL_WIDTH / 2);
  const rawPeaks: number[] = [];

  for (let i = 0; i < beatLogits.length; i++) {
    const value = beatLogits[i];
    if (value <= 0) continue;
    let localMax = -Infinity;
    const start = Math.max(0, i - radius);
    const end = Math.min(beatLogits.length - 1, i + radius);
    for (let j = start; j <= end; j++) {
      if (beatLogits[j] > localMax) localMax = beatLogits[j];
    }
    if (value === localMax) {
      let refinedIndex = i;
      if (i > 0 && i < (beatLogits.length - 1)) {
        const y0 = beatLogits[i - 1];
        const y1 = beatLogits[i];
        const y2 = beatLogits[i + 1];
        const denominator = y0 - (2 * y1) + y2;
        if (Math.abs(denominator) > 1e-8) {
          const delta = (0.5 * (y0 - y2)) / denominator;
          if (Number.isFinite(delta) && Math.abs(delta) <= 1) {
            refinedIndex = i + delta;
          }
        }
      }
      rawPeaks.push(refinedIndex);
    }
  }

  const deduped = deduplicatePeaks(rawPeaks, 1);
  return deduped.map((frame) => frame / FRAMES_PER_SECOND);
};

const estimateBpm = (beatTimes: number[]): number => {
  if (beatTimes.length < 2) return DEFAULT_BPM;
  const candidates: Array<{ bpm: number; weight: number }> = [];

  for (let i = 0; i < beatTimes.length - 1; i++) {
    const maxJ = Math.min(beatTimes.length, i + MAX_IOI_BEATS + 1);
    for (let j = i + 1; j < maxJ; j++) {
      const dt = beatTimes[j] - beatTimes[i];
      if (dt <= 0) continue;
      const beatDistance = j - i;
      let bpm = (60 * beatDistance) / dt;
      while (bpm < BPM_MIN) bpm *= 2;
      while (bpm > BPM_MAX) bpm /= 2;
      if (bpm >= BPM_MIN && bpm <= BPM_MAX) {
        candidates.push({ bpm, weight: 1 / beatDistance });
      }
    }
  }

  if (candidates.length === 0) {
    const intervals: number[] = [];
    for (let i = 1; i < beatTimes.length; i++) {
      const interval = beatTimes[i] - beatTimes[i - 1];
      if (interval >= MIN_INTERVAL_SECONDS && interval <= MAX_INTERVAL_SECONDS) {
        intervals.push(interval);
      }
    }
    if (intervals.length === 0) return DEFAULT_BPM;
    intervals.sort((a, b) => a - b);
    const med = intervals[Math.floor(intervals.length / 2)];
    let bpm = 60 / med;
    while (bpm < BPM_MIN) bpm *= 2;
    while (bpm > BPM_MAX) bpm /= 2;
    return Number(bpm.toFixed(2));
  }

  const binCount = Math.floor((BPM_MAX - BPM_MIN) / BPM_BIN_WIDTH) + 1;
  const bins = new Float32Array(binCount);
  for (const { bpm, weight } of candidates) {
    const index = Math.max(0, Math.min(binCount - 1, Math.round((bpm - BPM_MIN) / BPM_BIN_WIDTH)));
    bins[index] += weight;
  }

  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < binCount; i++) {
    let score = bins[i];
    if (i > 0) score += bins[i - 1] * 0.6;
    if (i < (binCount - 1)) score += bins[i + 1] * 0.6;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const peakBpm = BPM_MIN + (bestIndex * BPM_BIN_WIDTH);
  let weightedSum = 0;
  let weightTotal = 0;
  for (const { bpm, weight } of candidates) {
    if (Math.abs(bpm - peakBpm) <= 1.5) {
      weightedSum += bpm * weight;
      weightTotal += weight;
    }
  }
  const finalBpm = weightTotal > 0 ? (weightedSum / weightTotal) : peakBpm;
  return Number(finalBpm.toFixed(2));
};

const estimateConstantOffset = (beatTimes: number[], secondsPerBeat: number): number => {
  if (beatTimes.length === 0 || !Number.isFinite(secondsPerBeat) || secondsPerBeat <= 0) {
    return 0;
  }

  let sumSin = 0;
  let sumCos = 0;
  for (const time of beatTimes) {
    const phase = ((time % secondsPerBeat) + secondsPerBeat) % secondsPerBeat;
    const angle = (phase / secondsPerBeat) * Math.PI * 2;
    sumSin += Math.sin(angle);
    sumCos += Math.cos(angle);
  }

  // If the circular mean is undefined, fall back to first detected beat phase.
  if (Math.abs(sumSin) < 1e-8 && Math.abs(sumCos) < 1e-8) {
    return ((beatTimes[0] % secondsPerBeat) + secondsPerBeat) % secondsPerBeat;
  }

  let meanAngle = Math.atan2(sumSin, sumCos);
  if (meanAngle < 0) meanAngle += Math.PI * 2;
  return (meanAngle / (Math.PI * 2)) * secondsPerBeat;
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

    const { data: spectrogram, frameCount } = computeLogMelSpectrogram(resampled);
    if (frameCount === 0) {
      return buildBeatGrid(DEFAULT_BPM, 0, buffer.duration);
    }

    const frameLogits = await inferFullTrackFrameLogits(spectrogram, frameCount);
    const beatTimes = minimalPostprocessedBeatTimes(frameLogits.beat)
      .filter((time) => Number.isFinite(time) && time >= 0 && time <= (buffer.duration + 0.1));

    if (beatTimes.length === 0) {
      return buildBeatGrid(DEFAULT_BPM, 0, buffer.duration);
    }

    const bpm = estimateBpm(beatTimes);
    const secondsPerBeat = 60 / bpm;
    const offset = estimateConstantOffset(beatTimes, secondsPerBeat);
    return buildBeatGrid(bpm, offset, buffer.duration);
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
