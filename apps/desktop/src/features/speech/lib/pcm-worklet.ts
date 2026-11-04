export const targetSampleRate = 24_000;
export const maxAudioChunkBytes = 16 * 1024;
export const pcmChunkSamples = targetSampleRate / 4;
export const pcmWorkletName = 'scholaros-pcm-capture';

type BiquadCoefficients = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

type BiquadState = {
  inputOne: number;
  inputTwo: number;
  outputOne: number;
  outputTwo: number;
};

type PcmWorkletCommand =
  | { kind: 'credit'; count: number }
  | { kind: 'stop' }
  | { kind: 'cancel' };

type PcmWorkletScope = typeof globalThis & {
  AudioWorkletProcessor?: new () => { port: MessagePort };
  registerProcessor?: (
    name: string,
    processor: new () => { port: MessagePort },
  ) => void;
  sampleRate?: number;
};

const createLowPassCoefficients = (
  sampleRate: number,
  cutoff: number,
  quality: number,
): BiquadCoefficients => {
  const omega = (2 * Math.PI * cutoff) / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * quality);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosine) / 2 / a0,
    b1: (1 - cosine) / a0,
    b2: (1 - cosine) / 2 / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  };
};

export class PcmResampler {
  private readonly step: number;
  private readonly filters: BiquadCoefficients[];
  private readonly filterStates: BiquadState[];
  private previousSample: number | null = null;
  private phase = 0;

  constructor(inputSampleRate: number, outputSampleRate = targetSampleRate) {
    if (
      !Number.isFinite(inputSampleRate) ||
      inputSampleRate <= 0 ||
      !Number.isFinite(outputSampleRate) ||
      outputSampleRate <= 0
    )
      throw new RangeError(
        'Audio sample rates must be positive finite values.',
      );
    this.step = inputSampleRate / outputSampleRate;
    this.filters =
      inputSampleRate > outputSampleRate
        ? [
            createLowPassCoefficients(
              inputSampleRate,
              outputSampleRate * 0.45,
              Math.SQRT1_2,
            ),
            createLowPassCoefficients(
              inputSampleRate,
              outputSampleRate * 0.45,
              Math.SQRT1_2,
            ),
          ]
        : [];
    this.filterStates = this.filters.map(() => ({
      inputOne: 0,
      inputTwo: 0,
      outputOne: 0,
      outputTwo: 0,
    }));
  }

  process(channels: readonly Float32Array[]) {
    if (channels.length === 0) return new Float32Array();
    const frameCount = channels[0]?.length ?? 0;
    if (channels.some((channel) => channel.length !== frameCount))
      throw new RangeError('Microphone channels have inconsistent frames.');

    const output: number[] = [];
    try {
      for (let frame = 0; frame < frameCount; frame += 1) {
        let mixedSample = 0;
        for (const channel of channels) mixedSample += channel[frame] ?? 0;
        mixedSample /= channels.length;
        if (!Number.isFinite(mixedSample))
          throw new RangeError(
            'Microphone audio contains a non-finite sample.',
          );
        mixedSample = this.filterSample(Math.max(-1, Math.min(1, mixedSample)));
        if (!Number.isFinite(mixedSample))
          throw new RangeError(
            'Microphone resampling produced a non-finite sample.',
          );

        if (this.previousSample === null) {
          this.previousSample = mixedSample;
          this.phase = this.step;
          output.push(mixedSample);
          continue;
        }

        while (this.phase <= 1) {
          output.push(
            this.previousSample +
              (mixedSample - this.previousSample) * this.phase,
          );
          this.phase += this.step;
        }
        this.phase -= 1;
        this.previousSample = mixedSample;
      }
    } catch (error) {
      output.fill(0);
      throw error;
    }
    const resampled = Float32Array.from(output);
    output.fill(0);
    return resampled;
  }

  reset() {
    this.previousSample = null;
    this.phase = 0;
    for (const state of this.filterStates) {
      state.inputOne = 0;
      state.inputTwo = 0;
      state.outputOne = 0;
      state.outputTwo = 0;
    }
  }

  private filterSample(sample: number) {
    let filteredSample = sample;
    for (let index = 0; index < this.filters.length; index += 1) {
      const coefficients = this.filters[index]!;
      const state = this.filterStates[index]!;
      const nextSample =
        coefficients.b0 * filteredSample +
        coefficients.b1 * state.inputOne +
        coefficients.b2 * state.inputTwo -
        coefficients.a1 * state.outputOne -
        coefficients.a2 * state.outputTwo;
      state.inputTwo = state.inputOne;
      state.inputOne = filteredSample;
      state.outputTwo = state.outputOne;
      state.outputOne = nextSample;
      filteredSample = nextSample;
    }
    return filteredSample;
  }
}

export const encodePcm16Le = (samples: Float32Array) => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  try {
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index] ?? 0;
      if (!Number.isFinite(sample))
        throw new RangeError('Microphone audio contains a non-finite sample.');
      const clipped = Math.max(-1, Math.min(1, sample));
      const pcm = Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
      view.setInt16(index * 2, pcm, true);
    }
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
  return bytes;
};

const audioWorkletScope = globalThis as PcmWorkletScope;
if (
  typeof audioWorkletScope.AudioWorkletProcessor === 'function' &&
  typeof audioWorkletScope.registerProcessor === 'function'
) {
  const ProcessorBase = audioWorkletScope.AudioWorkletProcessor;
  class PcmCaptureProcessor extends ProcessorBase {
    private readonly resampler = new PcmResampler(
      audioWorkletScope.sampleRate ?? targetSampleRate,
    );
    private readonly chunk = new Float32Array(pcmChunkSamples);
    private chunkOffset = 0;
    private credits = 0;
    private stopped = false;

    constructor() {
      super();
      this.port.onmessage = (event: MessageEvent<PcmWorkletCommand>) => {
        const command = event.data;
        if (command.kind === 'credit' && Number.isSafeInteger(command.count)) {
          this.credits = Math.min(3, this.credits + Math.max(0, command.count));
        } else if (command.kind === 'stop') {
          this.finish(true);
        } else if (command.kind === 'cancel') {
          this.finish(false);
        }
      };
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]) {
      for (const output of outputs)
        for (const channel of output) channel.fill(0);
      if (this.stopped) return false;

      const channels = inputs[0] ?? [];
      if (channels.length === 0) {
        this.fail('unsupported');
        return false;
      }

      try {
        const samples = this.resampler.process(channels);
        try {
          for (const sample of samples) {
            this.chunk[this.chunkOffset] = sample;
            this.chunkOffset += 1;
            if (this.chunkOffset === this.chunk.length) {
              if (this.credits === 0) {
                this.fail('limit-exceeded');
                return false;
              }
              if (!this.emitChunk(this.chunkOffset)) return false;
            }
          }
        } finally {
          samples.fill(0);
        }
      } catch {
        this.fail('unsupported');
        return false;
      }
      return true;
    }

    private emitChunk(count: number) {
      let bytes: Uint8Array;
      try {
        bytes = encodePcm16Le(this.chunk.subarray(0, count));
      } catch {
        this.fail('unsupported');
        return false;
      }
      this.chunk.fill(0);
      this.chunkOffset = 0;
      this.credits = Math.max(0, this.credits - 1);
      try {
        this.port.postMessage({ kind: 'chunk', buffer: bytes.buffer }, [
          bytes.buffer,
        ]);
      } catch {
        bytes.fill(0);
        this.fail('unsupported');
        return false;
      }
      return true;
    }

    private finish(flush: boolean) {
      if (this.stopped) return;
      if (flush && this.chunkOffset > 0) {
        if (!this.emitChunk(this.chunkOffset)) return;
      } else this.chunk.fill(0);
      this.stopped = true;
      this.chunkOffset = 0;
      this.resampler.reset();
      this.port.postMessage({ kind: 'stopped' });
    }

    private fail(code: 'unsupported' | 'limit-exceeded') {
      if (this.stopped) return;
      this.stopped = true;
      this.chunk.fill(0);
      this.chunkOffset = 0;
      this.resampler.reset();
      this.port.postMessage({ kind: 'error', code });
    }
  }

  audioWorkletScope.registerProcessor(pcmWorkletName, PcmCaptureProcessor);
}
