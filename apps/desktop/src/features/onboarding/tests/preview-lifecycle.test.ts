import { afterEach, expect, it, vi } from 'vitest';
import { resetPreview, startPreview } from '../services/preview';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../services/academic-tasks', () => ({
  academicTasks: { run: mocks.run },
}));
vi.mock('../../../lib/auth/main', () => ({ accountRequest: vi.fn() }));
vi.mock('../services/store', () => ({ getOnboardingState: vi.fn() }));
vi.mock('../services/browser-workspace', () => ({ getWorkspace: vi.fn() }));

afterEach(() => {
  resetPreview();
  vi.clearAllMocks();
});

it.each(['complete', 'failed', 'reset'] as const)(
  'releases browser ownership only after the %s preview task settles',
  async (outcome) => {
    let resolve!: () => void;
    let reject!: (cause: Error) => void;
    mocks.run.mockReturnValueOnce(
      new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const release = vi.fn();
    await startPreview('student-a', 'courses', release);
    expect(release).not.toHaveBeenCalled();
    if (outcome === 'reset') resetPreview();
    expect(release).not.toHaveBeenCalled();
    if (outcome === 'failed') reject(new Error('Page unavailable'));
    else resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  },
);
