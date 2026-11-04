import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getInferenceModel: vi.fn(() => ({ provider: 'configured-meta-model' })),
}));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: vi.fn((options) => options) },
}));

vi.mock('../models/inference', () => ({
  getInferenceModel: mocks.getInferenceModel,
  evidenceBudgetTokens: 6000,
}));

import { generateActivityCandidate } from '../activity-generation';

const safeGraphCandidateFixture = {
  title: 'Explore a wave',
  html: '<label for="frequency">Frequency</label><input id="frequency" type="range" value="3"><output id="feedback" aria-live="polite">3</output><svg role="img" aria-label="Wave graph"></svg>',
  css: 'svg { width: 100%; }',
  javascript:
    "const control = document.querySelector('#frequency'); const feedback = document.querySelector('#feedback'); control.addEventListener('input', () => { feedback.textContent = control.value; });",
  accessibleExplanation:
    'Change frequency and observe the updated output; at constant wave speed, higher frequency means shorter wavelength.',
};

const sourceReferences = [
  {
    sourceKind: 'context-version' as const,
    sourceId: 'context-item-1',
    versionId: 'context-version-1',
    courseId: 'course-1',
    locator: { kind: 'page' as const, page: 2 },
    title: 'Wave relationships',
    provenance: 'user-uploaded' as const,
    observedAt: '2026-11-03T00:00:00.000Z',
    state: 'current' as const,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateText.mockResolvedValue({ output: safeGraphCandidateFixture });
});

it('returns structured objective-driven content with host-owned source/version references', async () => {
  const candidate = await generateActivityCandidate(
    {
      objective: 'Predict how changing frequency changes wavelength.',
      sourceReferences,
      context: 'For this source, wave speed is constant.',
    },
    new AbortController().signal,
  );

  expect(candidate).toMatchObject({
    title: 'Explore a wave',
    objective: 'Predict how changing frequency changes wavelength.',
    sourceReferences,
    runtimeVersion: 1,
    accessibleExplanation: expect.stringContaining('Change frequency'),
  });
  expect(mocks.generateText).toHaveBeenCalledTimes(1);
  const request = mocks.generateText.mock.calls[0]?.[0];
  expect(request.model).toEqual({ provider: 'configured-meta-model' });
  expect(request.prompt).toContain(
    'Predict how changing frequency changes wavelength.',
  );
  expect(request.prompt).toContain('For this source, wave speed is constant.');
  expect(request.abortSignal).toBeInstanceOf(AbortSignal);
  expect(request.maxRetries).toBe(0);
});

it('supports science simulations and input activities without model-owned source IDs', async () => {
  const activities = [
    {
      objective: 'Predict how insulation changes the rate of heat loss.',
      output: {
        ...safeGraphCandidateFixture,
        title: 'Explore thermal transfer',
        html: '<label for="insulation">Insulation</label><input id="insulation" type="range"><output aria-live="polite"></output><canvas aria-label="Temperature simulation"></canvas>',
        javascript:
          "const control = document.querySelector('#insulation'); const canvas = document.querySelector('canvas'); control.addEventListener('input', () => { canvas.getContext('2d').fillRect(0, 0, Number(control.value), 20); });",
        accessibleExplanation:
          'Increase insulation to reduce simulated heat loss.',
      },
      expectedControl: 'insulation',
    },
    {
      objective: 'Use a student-selected frequency to classify the wave.',
      output: {
        ...safeGraphCandidateFixture,
        title: 'Classify a wave',
        html: '<label for="answer">Frequency</label><input id="answer" type="number"><output aria-live="polite"></output>',
        javascript:
          "const input = document.querySelector('#answer'); input.addEventListener('input', () => { document.querySelector('output').textContent = input.value; });",
        accessibleExplanation:
          'Enter a frequency and read the immediate classification.',
      },
      expectedControl: 'answer',
    },
  ];

  for (const activity of activities) {
    mocks.generateText.mockResolvedValueOnce({ output: activity.output });
    const generatedCandidate = await generateActivityCandidate(
      { objective: activity.objective, sourceReferences },
      new AbortController().signal,
    );
    expect(generatedCandidate.objective).toBe(activity.objective);
    expect(generatedCandidate.sourceReferences).toEqual(sourceReferences);
    expect(generatedCandidate.html).toContain(activity.expectedControl);
  }
});

it('does not call the model for an aborted request or an invalid learning objective', async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    generateActivityCandidate(
      { objective: 'Predict wave behavior.', sourceReferences },
      controller.signal,
    ),
  ).rejects.toThrow();
  await expect(
    generateActivityCandidate(
      { objective: '', sourceReferences },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(mocks.generateText).not.toHaveBeenCalled();
});

it('rejects an empty explanation instead of returning an inaccessible activity', async () => {
  mocks.generateText.mockResolvedValueOnce({
    output: { ...safeGraphCandidateFixture, accessibleExplanation: '' },
  });

  await expect(
    generateActivityCandidate(
      { objective: 'Predict wave behavior.', sourceReferences },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Activity generation returned an incomplete candidate.');
});

it('reserves a bounded visible activity answer by using explicit Meta low reasoning and nonstored structured output', async () => {
  await generateActivityCandidate(
    {
      objective: 'Draw y = 2x with an adjustable slope.',
      sourceReferences: [],
    },
    new AbortController().signal,
  );
  const request = mocks.generateText.mock.calls[0]?.[0];
  expect(request.reasoning).toBe('low');
  expect(request.instructions).toContain(
    'Never use innerHTML, outerHTML, document.write',
  );
  expect(request.instructions).toContain('including SVG namespace URLs');
  expect(request.maxOutputTokens).toBe(6000);
  expect(request.providerOptions).toEqual({
    openai: {
      forceReasoning: true,
      systemMessageMode: 'developer',
      store: false,
    },
  });
  expect(request.maxRetries).toBe(0);
});
