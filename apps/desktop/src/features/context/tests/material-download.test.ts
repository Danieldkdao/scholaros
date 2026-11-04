import { describe, expect, it, vi } from 'vitest';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import {
  downloadPdfFromObservedLink,
  readPdfInPage,
} from '../services/material-download';

const allowedHosts = ['school.example.edu'];
const pdfBytes = new TextEncoder().encode('%PDF-1.4\nsynthetic');
const base64 = Buffer.from(pdfBytes).toString('base64');

const observedPage = (_url: string, links: string[] = []): ObservedPage => ({
  url: 'https://school.example.edu/courses/1',
  title: 'Course',
  text: 'Course materials',
  links: links.map((link) => ({ label: 'Syllabus PDF', url: link })),
});

const createPage = (
  result: unknown,
  currentUrl = 'https://school.example.edu/courses/1',
) => {
  const page = {
    url: vi.fn(async () => currentUrl),
    evaluate: vi.fn(async (_fn?: unknown, _request?: unknown) => result),
  };
  return page as unknown as Parameters<
    typeof downloadPdfFromObservedLink
  >[0]['page'] &
    typeof page;
};

describe('readPdfInPage', () => {
  it('streams a bounded same-origin response and returns its final URL', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(pdfBytes, {
          headers: { 'content-type': 'application/pdf' },
        }),
    );

    const result = await readPdfInPage(
      {
        targetUrl: 'https://school.example.edu/files/syllabus.pdf',
        maxBytes: 100,
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://school.example.edu/files/syllabus.pdf',
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'manual',
      }),
    );
    expect(result).toMatchObject({
      status: 200,
      contentType: 'application/pdf',
      finalUrl: 'https://school.example.edu/files/syllabus.pdf',
      base64: Buffer.from(pdfBytes).toString('base64'),
    });
  });

  it('uses target-host credentials only when the observed page is cross-origin', async () => {
    const targetUrl = 'https://files.school.edu/reading.pdf';
    const fetcher = vi.fn(
      async () =>
        new Response(pdfBytes, {
          headers: { 'content-type': 'application/pdf' },
        }),
    );

    await readPdfInPage(
      {
        sourceOrigin: 'https://school.example.edu',
        targetUrl,
        maxBytes: 100,
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      targetUrl,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('stops before reading a response over the byte limit', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20));
          controller.close();
        },
      }),
      {
        headers: {
          'content-type': 'application/pdf',
          'content-length': '200',
        },
      },
    );

    const result = await readPdfInPage(
      {
        targetUrl: 'https://school.example.edu/files/syllabus.pdf',
        maxBytes: 10,
      },
      async () => response,
    );

    expect(result).toMatchObject({ reason: 'too-large' });
  });

  it('cancels a stream as soon as streamed bytes exceed the limit', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20));
          controller.enqueue(new Uint8Array(20));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/pdf' } },
    );

    const result = await readPdfInPage(
      {
        targetUrl: 'https://school.example.edu/files/syllabus.pdf',
        maxBytes: 30,
      },
      async () => response,
    );

    expect(result).toMatchObject({ reason: 'too-large' });
    expect(cancelled).toBe(true);
  });

  it('does not follow a redirect before host policy can inspect it', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/syllabus.pdf' },
        }),
    );

    const result = await readPdfInPage(
      {
        targetUrl: 'https://school.example.edu/files/syllabus.pdf',
        maxBytes: 100,
      },
      fetcher,
    );

    expect(result).toEqual({ reason: 'redirect' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('aborts the actual in-page fetch when its deadline expires', async () => {
    let fetchSignal: AbortSignal | undefined;
    const result = await readPdfInPage(
      {
        targetUrl: 'https://school.example.edu/files/syllabus.pdf',
        maxBytes: 100,
        timeoutMs: 5,
      },
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = options?.signal as AbortSignal;
          fetchSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    expect(result).toEqual({ reason: 'timeout' });
    expect(fetchSignal?.aborted).toBe(true);
  });
});

describe('downloadPdfFromObservedLink', () => {
  it('waits for host pacing after validating the link and before fetching the PDF', async () => {
    const targetUrl = 'https://school.example.edu/files/syllabus.pdf';
    const events: string[] = [];
    const page = createPage({
      status: 200,
      contentType: 'application/pdf',
      finalUrl: targetUrl,
      base64,
    });
    page.url.mockImplementation(async () => {
      events.push('validate-page');
      return 'https://school.example.edu/courses/1';
    });
    page.evaluate.mockImplementation(async () => {
      events.push('fetch-pdf');
      return {
        status: 200,
        contentType: 'application/pdf',
        finalUrl: targetUrl,
        base64,
      };
    });
    const waitForTurn = vi.fn(async () => {
      events.push('wait-for-turn');
    });

    const result = await downloadPdfFromObservedLink({
      page,
      observedPage: observedPage('ignored', [targetUrl]),
      targetUrl,
      allowedHosts,
      beforeFetch: async (url) => {
        expect(url).toBe(targetUrl);
        await waitForTurn();
      },
    });

    expect(result.status).toBe('complete');
    expect(events).toEqual([
      'validate-page',
      'wait-for-turn',
      'validate-page',
      'fetch-pdf',
    ]);
    expect(waitForTurn).toHaveBeenCalledOnce();
  });

  it('rejects a PDF if the page changes while waiting for host pacing', async () => {
    const targetUrl = 'https://school.example.edu/files/syllabus.pdf';
    const page = createPage({
      status: 200,
      contentType: 'application/pdf',
      finalUrl: targetUrl,
      base64,
    });
    page.url
      .mockResolvedValueOnce('https://school.example.edu/courses/1')
      .mockResolvedValueOnce('https://school.example.edu/courses/2');
    const beforeFetch = vi.fn(async () => undefined);

    const result = await downloadPdfFromObservedLink({
      page,
      observedPage: observedPage('ignored', [targetUrl]),
      targetUrl,
      allowedHosts,
      beforeFetch,
    });

    expect(result).toEqual({ status: 'unreadable', reason: 'page-changed' });
    expect(beforeFetch).toHaveBeenCalledOnce();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('downloads only a link exposed by the currently observed page', async () => {
    const targetUrl = 'https://school.example.edu/files/syllabus.pdf';
    const page = createPage({
      status: 200,
      contentType: 'application/pdf',
      finalUrl: targetUrl,
      base64,
    });

    const result = await downloadPdfFromObservedLink({
      page,
      observedPage: observedPage('ignored', [targetUrl]),
      targetUrl,
      allowedHosts,
    });

    expect(result).toEqual({
      status: 'complete',
      url: targetUrl,
      bytes: pdfBytes,
    });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('rejects unobserved and unsafe links but accepts authorized external files', async () => {
    const targetUrl = 'https://school.example.edu/files/syllabus.pdf';
    const page = createPage({});
    const beforeFetch = vi.fn(async () => undefined);

    await expect(
      downloadPdfFromObservedLink({
        page,
        observedPage: observedPage('ignored'),
        targetUrl,
        allowedHosts,
        beforeFetch,
      }),
    ).resolves.toMatchObject({ status: 'unreadable', reason: 'unobserved' });
    expect(beforeFetch).not.toHaveBeenCalled();
    await expect(
      downloadPdfFromObservedLink({
        page,
        observedPage: observedPage('ignored', [
          'https://evil.example/file.pdf',
        ]),
        targetUrl: 'https://evil.example/file.pdf',
        allowedHosts,
      }),
    ).resolves.toMatchObject({ status: 'unreadable', reason: 'unsafe-url' });
    const externalUrl = 'https://cdn.example.edu/file.pdf';
    const externalPage = createPage({
      status: 200,
      contentType: 'application/pdf',
      finalUrl: externalUrl,
      base64,
    });
    const externalResult = await downloadPdfFromObservedLink({
      page: externalPage,
      observedPage: observedPage('ignored', [externalUrl]),
      targetUrl: externalUrl,
      allowedHosts: [...allowedHosts, 'cdn.example.edu'],
    });

    expect(externalResult).toEqual({
      status: 'complete',
      url: externalUrl,
      bytes: pdfBytes,
    });
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(externalPage.evaluate).toHaveBeenCalledOnce();
  });

  it('rejects redirects outside the connected host set and non-PDF bytes', async () => {
    const targetUrl = 'https://school.example.edu/files/syllabus.pdf';
    const redirected = createPage({
      status: 200,
      contentType: 'application/pdf',
      finalUrl: 'https://evil.example/files/syllabus.pdf',
      base64,
    });
    const wrongType = createPage({
      status: 200,
      contentType: 'text/html',
      finalUrl: targetUrl,
      base64,
    });

    const redirectResult = await downloadPdfFromObservedLink({
      page: redirected,
      observedPage: observedPage('ignored', [targetUrl]),
      targetUrl,
      allowedHosts,
    });
    const typeResult = await downloadPdfFromObservedLink({
      page: wrongType,
      observedPage: observedPage('ignored', [targetUrl]),
      targetUrl,
      allowedHosts,
    });

    expect(redirectResult).toMatchObject({
      status: 'unreadable',
      reason: 'redirect',
    });
    expect(typeResult).toMatchObject({
      status: 'unreadable',
      reason: 'wrong-type',
    });
  });

  it('aborts the in-page request when the mission is cancelled', async () => {
    const controller = new AbortController();
    const page = createPage(null);
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    page.evaluate.mockImplementation(async (_fn, request) => {
      const action = (request as { action: 'fetch' | 'abort' }).action;
      if (action === 'abort') return { aborted: true };
      markFetchStarted();
      return new Promise(() => undefined);
    });
    const result = downloadPdfFromObservedLink({
      page,
      observedPage: observedPage('ignored', [
        'https://school.example.edu/files/syllabus.pdf',
      ]),
      targetUrl: 'https://school.example.edu/files/syllabus.pdf',
      allowedHosts,
      signal: controller.signal,
    });

    await fetchStarted;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    const fetchRequest = page.evaluate.mock.calls[0]?.[1] as {
      action: string;
      requestId: string;
    };
    const abortRequest = page.evaluate.mock.calls[1]?.[1] as {
      action: string;
      requestId: string;
    };
    expect(fetchRequest.action).toBe('fetch');
    expect(abortRequest).toEqual({
      action: 'abort',
      requestId: fetchRequest.requestId,
    });
  });
});
