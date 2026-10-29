import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFileIcon: vi.fn(async () => ({
    toDataURL: () => 'data:image/png;base64,icon',
  })),
}));

vi.mock('electron', () => ({
  app: {
    getFileIcon: mocks.getFileIcon,
    getPath: () => '/users/student/AppData/Roaming',
  },
  dialog: {},
}));
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (file: string) => {
    if (!file.startsWith('/Applications/Google Chrome.app/'))
      throw new Error('Not installed');
    return file;
  }),
  access: vi.fn(async () => undefined),
  readFile: vi.fn(
    async () => '<key>CFBundleShortVersionString</key><string>145.0</string>',
  ),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
});

afterEach(() => vi.restoreAllMocks());

describe('browser discovery on macOS', () => {
  it('uses a supported icon size so finding browsers does not crash Electron', async () => {
    const { findBrowsers } = await import('../services/browser-discovery');
    const browsers = await findBrowsers();

    expect(browsers).toHaveLength(1);
    expect(mocks.getFileIcon).toHaveBeenCalledWith(
      '/Applications/Google Chrome.app',
      { size: 'normal' },
    );
    expect(browsers[0]).toMatchObject({
      name: 'Google Chrome',
      version: '145.0',
      icon: 'data:image/png;base64,icon',
    });
    expect(browsers[0]).not.toHaveProperty('executable');
  });

  it('still lists the browser when icon lookup rejects', async () => {
    mocks.getFileIcon.mockRejectedValueOnce(new Error('Icon unavailable'));
    const { findBrowsers } = await import('../services/browser-discovery');

    expect(await findBrowsers()).toEqual([
      expect.objectContaining({ name: 'Google Chrome', icon: null }),
    ]);
  });
});
