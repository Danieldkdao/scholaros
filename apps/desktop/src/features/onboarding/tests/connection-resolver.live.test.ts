import { describe, expect, it } from 'vitest';
import { validateConnectionCandidates } from '../services/connection-approval';

// Test-runner opt-in stays outside application env validation so normal tests
// neither load real credentials nor make billable provider requests.
describe.skipIf(process.env.RUN_LIVE_INFERENCE !== '1')(
  'live connection search',
  () => {
    const search = async (prompt: string) => {
      const { resolveConnectionRequests } =
        await import('@scholaros/services/ai/connection-resolver');
      const result = await resolveConnectionRequests(
        prompt,
        AbortSignal.timeout(25_000),
      );
      return validateConnectionCandidates(result.candidates);
    };

    it('finds learning resources for the reported broad math request', async () => {
      const candidates = await search('find some math websites');
      expect(candidates.length).toBeGreaterThan(0);
      expect(
        candidates.some((candidate) =>
          [
            'khanacademy.org',
            'desmos.com',
            'geogebra.org',
            'brilliant.org',
            'mathworld.wolfram.com',
            'mathsisfun.com',
            'artofproblemsolving.com',
          ].some(
            (host) =>
              new URL(candidate.url).hostname.replace(/^www\./, '') === host,
          ),
        ),
      ).toBe(true);
    }, 30_000);

    it('finds a named learning service', async () => {
      const candidates = await search('Connect Khan Academy');
      expect(
        candidates.some(
          (candidate) =>
            new URL(candidate.url).hostname.replace(/^www\./, '') ===
            'khanacademy.org',
        ),
      ).toBe(true);
    }, 30_000);

    it('does not invent a school portal when the school is unspecified', async () => {
      expect(await search("Find my school's Canvas course dashboard")).toEqual(
        [],
      );
    }, 30_000);
  },
);
