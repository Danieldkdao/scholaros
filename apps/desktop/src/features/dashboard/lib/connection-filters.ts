import { z } from 'zod';
import type { AcademicConnection } from '../../onboarding/types';

export const connectionStatusFilters = [
  'all',
  'verified',
  'confirmed',
  'needs-sign-in',
] as const;
export type ConnectionStatusFilter = (typeof connectionStatusFilters)[number];
export const connectionKindFilters = [
  'all',
  'canvas',
  'classroom',
  'resource',
] as const;
export type ConnectionKindFilter = (typeof connectionKindFilters)[number];
export const connectionSearchSchema = z.object({
  q: z.string().catch(''),
  status: z.enum(connectionStatusFilters).catch('all'),
  kind: z.enum(connectionKindFilters).catch('all'),
});
export type ConnectionSearchSchema = z.infer<typeof connectionSearchSchema>;
// Links to the list must name every filter, so the schema supplies them rather
// than each caller repeating the catch-all values.
export const defaultConnectionSearch = connectionSearchSchema.parse({});

export const filterConnections = (
  connections: AcademicConnection[],
  search: ConnectionSearchSchema,
) => {
  const query = search.q.trim().toLowerCase();
  return connections.filter(
    (connection) =>
      (search.status === 'all' || connection.status === search.status) &&
      (search.kind === 'all' || connection.kind === search.kind) &&
      (!query ||
        [connection.name, connection.host, connection.notes ?? ''].some(
          (value) => value.toLowerCase().includes(query),
        )),
  );
};
