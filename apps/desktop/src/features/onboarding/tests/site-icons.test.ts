import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ net: { fetch: fetchMock } }));

const { fetchSiteIcon } = await import('../services/site-icons');

const png = [137, 80, 78, 71];

const response = (body: number[], contentType = 'image/png', status = 200) =>
  new Response(new Uint8Array(body), {
    status,
    headers: { 'content-type': contentType },
  });

const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  fetchMock.mockReset();
});

describe('site icons', () => {
  it('encodes the declared icon as a data url', async () => {
    fetchMock.mockResolvedValue(response(png));

    const dataUrl = await fetchSiteIcon(
      'school.edu',
      'https://cdn.school.edu/logo.png',
    );
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(dataUrl!.split(',')[1]!, 'base64')).toEqual(
      Buffer.from(png),
    );
  });

  it('falls back to the host favicon when no icon is declared', async () => {
    fetchMock.mockResolvedValue(response(png));

    await expect(fetchSiteIcon('school.edu', null)).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
    expect(fetchedUrls()).toEqual(['https://school.edu/favicon.ico']);
  });

  it('tries the host favicon after the declared icon is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(response(png, 'image/png', 404))
      .mockResolvedValueOnce(response(png));

    await expect(
      fetchSiteIcon('school.edu', 'https://school.edu/missing.png'),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    expect(fetchedUrls()).toEqual([
      'https://school.edu/missing.png',
      'https://school.edu/favicon.ico',
    ]);
  });

  it('fetches an icon the page declared on its own content host', async () => {
    fetchMock.mockResolvedValue(response(png));

    // School sites routinely serve branding from a shared asset host, so the
    // declared address must not be pinned to the district subdomain.
    await fetchSiteIcon(
      'usd497.schoology.com',
      'https://cdn.schoology.com/i.png',
    );
    expect(fetchedUrls()).toEqual(['https://cdn.schoology.com/i.png']);
  });

  it.each([
    'http://school.edu/logo.png',
    'https://127.0.0.1/logo.png',
    'https://169.254.169.254/latest/meta-data',
    'https://printer.local/logo.png',
    'https://user:pass@school.edu/logo.png',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url',
  ])('refuses the unsafe declared address %s', async (declared) => {
    fetchMock.mockResolvedValue(response(png));

    await fetchSiteIcon('school.edu', declared);
    expect(fetchedUrls()).toEqual(['https://school.edu/favicon.ico']);
  });

  it('rejects a response that is not an image', async () => {
    fetchMock.mockResolvedValue(response([68, 69, 78], 'text/html'));

    await expect(fetchSiteIcon('school.edu', null)).resolves.toBeNull();
  });

  it('rejects an icon larger than the storage budget', async () => {
    fetchMock.mockResolvedValue(response(Array(65_537).fill(137)));

    await expect(fetchSiteIcon('school.edu', null)).resolves.toBeNull();
  });

  it('reports no icon instead of failing the connection', async () => {
    // A connection can drop after the headers arrive, so the body read is the
    // failure a connect run has to survive.
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('net::ERR_CONNECTION_CLOSED'));
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
    );

    await expect(fetchSiteIcon('school.edu', null)).resolves.toBeNull();
  });
});

it('cancels an oversized icon stream without consuming its remaining chunks', async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4096));
        if (pulls === 100) controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  fetchMock
    .mockResolvedValueOnce(
      new Response(stream, { headers: { 'content-type': 'image/png' } }),
    )
    .mockResolvedValueOnce(response([], 'image/png', 404));
  await expect(
    fetchSiteIcon('school.edu', 'https://cdn.school.edu/icon.png'),
  ).resolves.toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(pulls).toBe(17);
});

it('rejects redirects before they can reach an unchecked destination', async () => {
  fetchMock.mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: {
        location: 'http://127.0.0.1/private',
        'content-type': 'image/png',
      },
    }),
  );
  await expect(fetchSiteIcon('school.edu', null)).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledWith(
    'https://school.edu/favicon.ico',
    expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
  );
});

it.each([0, 1])(
  'aborts a stalled icon request without starting another fallback: %s',
  async (fallback) => {
    const controller = new AbortController();
    if (fallback)
      fetchMock.mockResolvedValueOnce(response([], 'image/png', 404));
    fetchMock.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const pending = fetchSiteIcon(
      'school.edu',
      'https://cdn.school.edu/icon.png',
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(fallback + 1),
    );
    const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    controller.abort();
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(fallback + 1);
  },
);

it('releases connection ownership promptly when a stalled icon fetch is cancelled', async () => {
  const { createConnectCoordinator } =
    await import('../services/connect-coordinator');
  fetchMock.mockImplementation(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => reject(options.signal!.reason),
          { once: true },
        );
      }),
  );
  const release = vi.fn();
  const coordinator = createConnectCoordinator({
    acquire: async () => ({ release, signal: new AbortController().signal }),
    browser: async () => ({
      inspect: async () => ({
        status: 'readable' as const,
        host: 'school.edu',
      }),
      capture: async (_candidate, signal) => {
        await fetchSiteIcon('school.edu', null, signal);
      },
      close: async () => undefined,
    }),
  });
  await coordinator.start('student', {
    candidates: [
      { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
    ],
  });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  await coordinator.cancel('student');
  expect(coordinator.getState('student').status).toBe('cancelled');
  expect(release).toHaveBeenCalledOnce();
  expect(coordinator.isBusy()).toBe(false);
});
