import { describe, expect, it } from 'vitest';
import {
  connectionKindFilters,
  connectionStatusFilters,
} from '../lib/connection-filters';
import {
  formatConnectionKindFilter,
  formatConnectionStatusFilter,
} from '../lib/formatters';
import {
  formatConnectionStatus,
  formatResourceKind,
} from '../../onboarding/lib/formatters';

describe('connection filter options', () => {
  it('gives every status filter a label and an icon', () => {
    for (const filter of connectionStatusFilters) {
      const option = formatConnectionStatusFilter(filter);
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.Icon).toBeTruthy();
    }
  });

  it('gives every kind filter a label and an icon', () => {
    for (const filter of connectionKindFilters) {
      const option = formatConnectionKindFilter(filter);
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.Icon).toBeTruthy();
    }
  });

  it('labels each narrow filter exactly like the connection cards', () => {
    for (const filter of connectionStatusFilters) {
      if (filter === 'all') continue;
      expect(formatConnectionStatusFilter(filter)).toEqual(
        formatConnectionStatus(filter),
      );
    }
    for (const filter of connectionKindFilters) {
      if (filter === 'all') continue;
      expect(formatConnectionKindFilter(filter)).toEqual(
        formatResourceKind(filter),
      );
    }
  });

  it('names the catch-all filters after the control they belong to', () => {
    expect(formatConnectionStatusFilter('all').label).toBe('All statuses');
    expect(formatConnectionKindFilter('all').label).toBe('All kinds');
  });
});
