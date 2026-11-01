import { describe, expect, it } from 'vitest';
import {
  connectionSearchSchema,
  filterConnections,
} from '../lib/connection-filters';
import type { AcademicConnection } from '../../onboarding/types';
const connections: AcademicConnection[] = [
  {
    id: 'a',
    name: 'Canvas',
    host: 'school.edu',
    url: 'https://school.edu',
    kind: 'canvas',
    status: 'verified',
    verifiedAt: null,
    notes: 'Biology lab',
    favicon: null,
    isCourseResource: false,
  },
  {
    id: 'b',
    name: 'Books',
    host: 'books.edu',
    url: 'https://books.edu',
    kind: 'resource',
    status: 'needs-sign-in',
    verifiedAt: null,
    notes: null,
    favicon: null,
    isCourseResource: false,
  },
];
describe('connection filters', () => {
  it('recovers malformed search parameters', () => {
    expect(
      connectionSearchSchema.parse({ q: 5, status: 'bad', kind: 'bad' }),
    ).toEqual({ q: '', status: 'all', kind: 'all' });
  });
  it('matches names, hosts, and notes without regard to case', () => {
    for (const q of ['CANVAS', 'SCHOOL.EDU', 'BIOLOGY'])
      expect(
        filterConnections(connections, { q, status: 'all', kind: 'all' }).map(
          (item) => item.id,
        ),
      ).toEqual(['a']);
  });
  it('combines status and kind', () => {
    expect(
      filterConnections(connections, {
        q: '',
        status: 'needs-sign-in',
        kind: 'resource',
      }).map((item) => item.id),
    ).toEqual(['b']);
  });
});
