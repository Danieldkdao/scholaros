import { describe, expect, it } from 'vitest';
import { createLaunchTracker } from '../lib/launch-tracker';

describe('browser launch tracker', () => {
  it('keeps a launch current until it is cancelled', () => {
    const tracker = createLaunchTracker();
    const attempt = tracker.begin();
    expect(tracker.isCurrent(attempt)).toBe(true);
    tracker.cancel();
    expect(tracker.isCurrent(attempt)).toBe(false);
  });

  it('does not let an old launch outlive a newer one', () => {
    const tracker = createLaunchTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
  });
});
