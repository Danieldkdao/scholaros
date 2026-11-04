import { describe, expect, it } from 'vitest';
import { encodePcm16Le, PcmResampler } from '../lib/pcm-worklet';

const sineWave = (sampleRate: number, frequency: number, sampleCount: number) =>
  Float32Array.from(
    { length: sampleCount },
    (_, index) =>
      Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.8,
  );

describe('PCM worklet helpers', () => {
  it('resamples streamed sine input to 24 kHz without changing its frequency', () => {
    const inputRate = 48_000;
    const samples = sineWave(inputRate, 440, inputRate);
    const resampler = new PcmResampler(inputRate);
    const output: Float32Array[] = [];

    for (let offset = 0; offset < samples.length; offset += 128)
      output.push(resampler.process([samples.subarray(offset, offset + 128)]));

    const resampled = Float32Array.from(output.flatMap((chunk) => [...chunk]));
    let risingZeroCrossings = 0;
    for (let index = 1; index < resampled.length; index += 1)
      if (resampled[index - 1]! <= 0 && resampled[index]! > 0)
        risingZeroCrossings += 1;

    expect(resampled).toHaveLength(24_000);
    expect(risingZeroCrossings).toBeCloseTo(440, 0);
  });

  it('suppresses frequencies above the output Nyquist range', () => {
    const inputRate = 48_000;
    const samples = sineWave(inputRate, 18_000, inputRate);
    const resampled = new PcmResampler(inputRate).process([samples]);
    const rootMeanSquare = Math.sqrt(
      resampled.reduce((sum, sample) => sum + sample * sample, 0) /
        resampled.length,
    );

    expect(rootMeanSquare).toBeLessThan(0.2);
  });

  it('downmixes silence to zero-valued little-endian PCM16', () => {
    const resampler = new PcmResampler(48_000);
    const resampled = resampler.process([
      new Float32Array(960),
      new Float32Array(960),
    ]);
    const pcm = encodePcm16Le(resampled);

    expect(resampled).toHaveLength(480);
    expect([...pcm].every((byte) => byte === 0)).toBe(true);
  });

  it('clips finite samples and rejects invalid sample rates or non-finite input', () => {
    expect([...encodePcm16Le(Float32Array.of(-2, 2))]).toEqual([
      0, 128, 255, 127,
    ]);
    expect(() => new PcmResampler(Number.NaN)).toThrow();
    expect(() =>
      new PcmResampler(48_000).process([Float32Array.of(Infinity)]),
    ).toThrow();
  });
});
