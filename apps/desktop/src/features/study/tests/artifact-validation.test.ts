import { expect, it } from 'vitest';
import {
  createActivityCandidateDigest,
  validateActivityCandidate,
} from '../services/artifact-validation';

const safeGraphCandidateFixture = {
  title: 'Explore a wave',
  objective: 'Predict how changing frequency changes wavelength.',
  html: '<section><label for="frequency">Frequency</label><input id="frequency" type="range" min="1" max="10" value="3"><output id="feedback" aria-live="polite">3</output><svg role="img" aria-label="Wave graph"><polyline id="wave" points="0,50 25,20 50,50 75,80 100,50"></polyline></svg></section>',
  css: 'svg { width: 100%; height: 12rem; }',
  javascript:
    "const control = document.querySelector('#frequency'); const feedback = document.querySelector('#feedback'); const wave = document.querySelector('#wave'); const draw = () => { const frequency = Number(control.value); const wavelength = 100 / frequency; const points = []; for (let x = 0; x <= 100; x += 2) points.push(x + ',' + (50 + 20 * Math.sin(2 * Math.PI * x / wavelength))); wave.setAttribute('points', points.join(' ')); feedback.textContent = `Wavelength: ${wavelength.toFixed(1)}`; }; control.addEventListener('input', draw); draw();",
  accessibleExplanation:
    'Move the frequency control and compare the live wavelength readout; higher frequency means shorter wavelength at the same wave speed.',
  sourceReferences: [],
  runtimeVersion: 1 as const,
};

const safeScienceSimulationCandidateFixture = {
  ...safeGraphCandidateFixture,
  title: 'Explore thermal transfer',
  objective: 'Predict how insulation changes the rate of heat loss.',
  html: '<label for="insulation">Insulation</label><input id="insulation" type="range" min="0" max="10" value="4"><output id="temperature" aria-live="polite"></output><canvas id="simulation" role="img" aria-label="Temperature simulation"></canvas>',
  javascript:
    "const control = document.querySelector('#insulation'); const output = document.querySelector('#temperature'); const canvas = document.querySelector('#simulation'); const draw = () => { const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height); context.fillRect(0, 0, Number(control.value) * 10, 20); output.textContent = `Heat loss: ${10 - Number(control.value)}`; }; control.addEventListener('input', draw); draw();",
  accessibleExplanation:
    'Increase insulation to reduce the simulated heat-loss bar; this simplified model shows the direction of change rather than a measured temperature.',
};

const safeInputDrivenCandidateFixture = {
  ...safeGraphCandidateFixture,
  title: 'Classify a wave',
  objective: 'Use a student-selected frequency to classify the wave.',
  html: '<label for="student-frequency">Frequency</label><input id="student-frequency" type="number" min="1" max="10"><output id="classification" aria-live="polite"></output>',
  javascript:
    "const input = document.querySelector('#student-frequency'); const output = document.querySelector('#classification'); input.addEventListener('input', () => { output.textContent = Number(input.value) > 5 ? 'High frequency' : 'Low frequency'; });",
  accessibleExplanation:
    'Enter a frequency from 1 to 10 and read the immediate low- or high-frequency classification.',
};

it.each([
  ['science simulation', safeScienceSimulationCandidateFixture],
  ['input activity', safeInputDrivenCandidateFixture],
])('accepts an objective-driven %s with feedback', async (_name, candidate) => {
  const result = await validateActivityCandidate(candidate);

  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(result.candidate.objective).toBe(candidate.objective);
});

it('accepts a bounded, objective-driven activity and preserves its exact digest input', async () => {
  const result = await validateActivityCandidate(safeGraphCandidateFixture);

  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.candidate).toEqual(safeGraphCandidateFixture);
  expect(result.serializedCandidate).toBe(
    JSON.stringify(safeGraphCandidateFixture),
  );
  expect(result.contentDigest).toMatch(/^[a-f0-9]{64}$/);
});

it('computes the persisted P20 digest from the canonical candidate fields', async () => {
  const result = await validateActivityCandidate(safeGraphCandidateFixture);

  expect(result).toMatchObject({ ok: true });
  expect(createActivityCandidateDigest(safeGraphCandidateFixture)).toBe(
    result.ok ? result.contentDigest : null,
  );
});

it.each([
  [
    'event-handler HTML',
    {
      ...safeGraphCandidateFixture,
      html: '<button onclick="fetch(\'/\')">Try</button>',
    },
  ],
  [
    'remote URL attributes',
    {
      ...safeGraphCandidateFixture,
      html: '<img src="https://example.invalid/track.png"><button>Try</button>',
    },
  ],
  [
    'HTML script blocks',
    {
      ...safeGraphCandidateFixture,
      html: '<script>alert(1)</script><button>Try</button>',
    },
  ],
  [
    'CSS imports and URL loads',
    {
      ...safeGraphCandidateFixture,
      css: '@import url(https://example.invalid/x.css);',
    },
  ],
  [
    'network and privileged JavaScript globals',
    {
      ...safeGraphCandidateFixture,
      javascript:
        "document.querySelector('button').addEventListener('click', () => fetch('https://example.invalid'));",
    },
  ],
  [
    'dynamic code and obfuscated payload helpers',
    {
      ...safeGraphCandidateFixture,
      javascript: "const run = new Function(atob('YWxlcnQoMSk='));",
    },
  ],
  [
    'native file-picker controls',
    {
      ...safeGraphCandidateFixture,
      html: '<label for="upload">Choose a file</label><input id="upload" type="file"><output aria-live="polite"></output>',
    },
  ],
  [
    'hidden answer data attributes',
    {
      ...safeGraphCandidateFixture,
      html: '<div hidden data-answer="42">42</div><button>Try</button><output aria-live="polite"></output>',
    },
  ],
  [
    'visually hidden answer content',
    {
      ...safeGraphCandidateFixture,
      css: '.answer { display: none; }',
    },
  ],
  [
    'ARIA-hidden answer content',
    {
      ...safeGraphCandidateFixture,
      html: '<div aria-hidden="true">The answer is 42</div><button>Try</button><output aria-live="polite"></output>',
    },
  ],
  [
    'WebRTC and non-HTTP network surfaces',
    {
      ...safeGraphCandidateFixture,
      javascript: 'const connection = new RTCPeerConnection();',
    },
  ],
])(
  'rejects %s without returning candidate content',
  async (_name, candidate) => {
    const result = await validateActivityCandidate(candidate);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('example.invalid');
    expect(JSON.stringify(result)).not.toContain('YWxlcnQoMSk=');
  },
);

it('rejects a static visualization without an interactive control', async () => {
  const result = await validateActivityCandidate({
    ...safeGraphCandidateFixture,
    html: '<svg role="img" aria-label="Static wave graph"></svg>',
    javascript: 'const graph = document.querySelector("svg");',
  });

  expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
});

it('rejects a static graph when its control only changes a decorative readout', async () => {
  const result = await validateActivityCandidate({
    ...safeGraphCandidateFixture,
    html: '<label for="frequency">Frequency</label><input id="frequency" type="range"><output id="feedback" aria-live="polite"></output><svg role="img" aria-label="Wave graph"><polyline points="0,0 100,50"></polyline></svg>',
    javascript:
      "const control = document.querySelector('#frequency'); const feedback = document.querySelector('#feedback'); control.addEventListener('input', () => { feedback.textContent = control.value; });",
  });

  expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
});

it('rejects candidates above the 512 KiB wire bound before parsing', async () => {
  const result = await validateActivityCandidate({
    ...safeGraphCandidateFixture,
    javascript: 'x'.repeat(512 * 1024),
  });

  expect(result).toMatchObject({ ok: false, reason: 'limit-exceeded' });
});
