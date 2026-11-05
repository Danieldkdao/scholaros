import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: vi.fn((value) => value) },
}));
import { generateDemoTutor } from '../demo-tutor';
const experiment = {
  kind: 'osmosis',
  title: 'A cell in a new solution',
  introduction: 'Compare the two concentrations and make your prediction.',
  insideConcentration: 3,
  outsideConcentration: 7,
  predictionQuestion: 'Which way will water move overall?',
};
beforeEach(() => mocks.generateText.mockReset());
it('returns a strict model-configured experiment without executable model content', async () => {
  mocks.generateText.mockResolvedValue({ output: experiment });
  const signal = new AbortController().signal;
  await expect(
    generateDemoTutor({
      action: 'experiment',
      apiKey: 'fixture-key',
      logging: false,
      signal,
    }),
  ).resolves.toEqual({
    text: experiment.introduction,
    model: 'muse-spark-1.3',
    experiment,
  });
  const request = mocks.generateText.mock.calls[0]![0];
  expect(request.output).toBeDefined();
  expect(request.abortSignal).toBe(signal);
  expect(request.maxRetries).toBe(0);
  expect(request.maxOutputTokens).toBeLessThanOrEqual(3072);
  expect(request.instructions).toContain('No HTML or JavaScript');
});
it.each([
  { ...experiment, insideConcentration: 11 },
  { ...experiment, outsideConcentration: -1 },
  { ...experiment, html: '<script>unsafe</script>' },
  undefined,
])('rejects an incomplete or out-of-bounds experiment %#', async (output) => {
  mocks.generateText.mockResolvedValue({ output });
  await expect(
    generateDemoTutor({
      action: 'experiment',
      apiKey: 'fixture-key',
      logging: false,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
});
it('preserves the fixed text-only sample actions', async () => {
  mocks.generateText.mockResolvedValue({ text: 'A loop visits each item.' });
  await expect(
    generateDemoTutor({
      action: 'explain',
      apiKey: 'fixture-key',
      logging: false,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({
    text: 'A loop visits each item.',
    model: 'muse-spark-1.3',
  });
  expect(mocks.generateText.mock.calls[0]![0].output).toBeUndefined();
});
