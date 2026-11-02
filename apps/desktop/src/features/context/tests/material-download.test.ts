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
    evaluate: vi.fn(async () => result),
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
        sourceOrigin: 'https://school.example.edu',
        targetUrl: 'https://school.example.edu/files/syllabus.pdf',
        maxBytes: 100,
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://school.example.edu/files/syllabus.pdf',
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'follow',
      }),
    );
    expect(result).toMatchObject({
      status: 200,
      contentType: 'application/pdf',
      finalUrl: 'https://school.example.edu/files/syllabus.pdf',
      base64: Buffer.from(pdfBytes).toString('base64'),
    });
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
        sourceOrigin: 'https://school.example.edu',
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
        sourceOrigin: 'https://school.example.edu',
        targetUrl: 'https://school.example.edu/files/syllabus.pdf',
        maxBytes: 30,
      },
      async () => response,
    );

    expect(result).toMatchObject({ reason: 'too-large' });
    expect(cancelled).toBe(true);
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

  it('rejects unobserved, unsafe, and cross-origin links before fetching', async () => {
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
    await expect(
      downloadPdfFromObservedLink({
        page,
        observedPage: observedPage('ignored', [
          'https://cdn.example.edu/file.pdf',
        ]),
        targetUrl: 'https://cdn.example.edu/file.pdf',
        allowedHosts: [...allowedHosts, 'cdn.example.edu'],
      }),
    ).resolves.toMatchObject({ status: 'unreadable', reason: 'cross-origin' });

    expect(page.evaluate).not.toHaveBeenCalled();
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

  it('rejects evaluation when the mission is cancelled', async () => {
    const controller = new AbortController();
    const page = createPage(new Promise(() => undefined));
    const result = downloadPdfFromObservedLink({
      page,
      observedPage: observedPage('ignored', [
        'https://school.example.edu/files/syllabus.pdf',
      ]),
      targetUrl: 'https://school.example.edu/files/syllabus.pdf',
      allowedHosts,
      signal: controller.signal,
    });
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
});
