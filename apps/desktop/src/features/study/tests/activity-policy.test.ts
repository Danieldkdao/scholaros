import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildActivityDocument,
  createActivityContentDigest,
} from '../services/activity-policy';
import {
  activitySchemePrivileges,
  createActivitySchemeRegistrar,
} from '../services/activity-protocol';

describe('activity document policy', () => {
  it('binds exact accepted inline script bytes to a default-deny response policy', () => {
    const sdk = 'window.sdkReady = true;';
    const javascript = 'window.answer = 42;';
    const document = buildActivityDocument({
      html: '<main>learning activity</main>',
      css: 'main { color: black; }',
      sdk,
      javascript,
    });
    const sdkHash = createHash('sha256').update(sdk, 'utf8').digest('base64');
    const activityHash = createHash('sha256')
      .update(javascript, 'utf8')
      .digest('base64');
    const bootstrapHash = createHash('sha256')
      .update(document.bootstrapScript, 'utf8')
      .digest('base64');
    const relayHash = createHash('sha256')
      .update(document.relayScript, 'utf8')
      .digest('base64');
    const csp = document.headers['Content-Security-Policy'];

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain(`'sha256-${sdkHash}'`);
    expect(csp).toContain(`'sha256-${activityHash}'`);
    expect(csp).toContain(`'sha256-${bootstrapHash}'`);
    expect(csp).toContain(`'sha256-${relayHash}'`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'self' about:");
    expect(document.body).toContain("frame-src 'none'");
    expect(document.body).toContain('sandbox="allow-scripts"');
    expect(csp).toContain("form-action 'none'");
    expect(document.headers['Connection-Allowlist']).toBe(
      '();webrtc=block;redirects=block',
    );
  });

  it('canonicalizes the accepted bundle digest regardless of property order', () => {
    const bundle = {
      html: '<main>Activity</main>',
      css: 'main { display: grid; }',
      sdk: 'window.sdkReady = true;',
      javascript: 'window.answer = 42;',
    };
    const reorderedBundle = {
      javascript: bundle.javascript,
      css: bundle.css,
      html: bundle.html,
      sdk: bundle.sdk,
    };

    expect(createActivityContentDigest(reorderedBundle)).toBe(
      createActivityContentDigest(bundle),
    );
  });

  it('keeps generated markup inert until main installs the one-shot bootstrap', () => {
    const document = buildActivityDocument({
      html: '<main><p>Activity</p><script>window.attackMarker = true;</script><iframe src="https://attacker.invalid/"></iframe></main>',
      css: '</style><script>window.cssMarker = true;</script>',
      sdk: 'window.sdkMarker = true;',
      javascript: 'window.generatedMarker = true;',
    });

    expect(document.body).toContain('Activity');
    expect(document.body).not.toContain('window.attackMarker');
    expect(document.body).not.toContain('attacker.invalid');
    expect(document.body).not.toContain('window.generatedMarker');
    expect(document.body).not.toContain('window.sdkMarker');
    expect(document.headers['Referrer-Policy']).toBe('no-referrer');
    expect(document.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(document.headers['Cache-Control']).toBe('no-store');
  });
});

describe('activity scheme initialization', () => {
  it('registers only the private activity protocol before app readiness', () => {
    const registerSchemesAsPrivileged = vi.fn();
    const isReady = vi.fn(() => false);
    const registerActivitySchemeBeforeReady = createActivitySchemeRegistrar({
      registerSchemesAsPrivileged,
      isReady,
    });

    registerActivitySchemeBeforeReady();
    registerActivitySchemeBeforeReady();

    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      activitySchemePrivileges,
    ]);
    expect(activitySchemePrivileges.scheme).toBe('scholar-activity');
    expect(activitySchemePrivileges.privileges).toMatchObject({
      standard: true,
      secure: true,
      bypassCSP: false,
      allowServiceWorkers: false,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: false,
      codeCache: false,
      allowExtensions: false,
    });
  });

  it('can compose the activity protocol into a single existing app-scheme registration', () => {
    const authScheme = {
      scheme: 'ai.scholaros.desktop',
      privileges: { secure: true },
    } satisfies Electron.CustomScheme;
    const registerSchemesAsPrivileged = vi.fn();
    const registerActivitySchemeBeforeReady = createActivitySchemeRegistrar({
      registerSchemesAsPrivileged: (schemes) =>
        registerSchemesAsPrivileged([authScheme, ...schemes]),
      isReady: () => false,
    });

    registerActivitySchemeBeforeReady();

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      authScheme,
      activitySchemePrivileges,
    ]);
  });

  it('fails closed if scheme registration is requested after app readiness', () => {
    const registerSchemesAsPrivileged = vi.fn();
    const registerActivitySchemeBeforeReady = createActivitySchemeRegistrar({
      registerSchemesAsPrivileged,
      isReady: () => true,
    });

    expect(registerActivitySchemeBeforeReady).toThrow(/before.*ready/i);
    expect(registerSchemesAsPrivileged).not.toHaveBeenCalled();
  });
});
