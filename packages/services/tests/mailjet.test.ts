import { beforeEach, expect, test, vi } from 'vitest';
import { sendEmail } from '../src/mailjet';
import { sendVerificationOtp } from '../src/mailjet/emails/verification-emails';

type Message = {
  From: { Email: string; Name: string };
  To: { Email: string }[];
  Subject: string;
  TextPart: string;
  HTMLPart: string;
};

const state = vi.hoisted(() => ({
  sentMessages: [] as Message[],
  deliveryFailure: null as unknown,
}));

vi.mock('@scholaros/env/server', () => ({
  serverEnv: {
    MAILJET_API_KEY: 'test-public-key',
    MAILJET_API_SECRET: 'test-private-key',
    SENDER_EMAIL: 'scholaros@example.com',
  },
}));
vi.mock('node-mailjet', () => ({
  default: {
    apiConnect: (key: string, secret: string, config: unknown) => {
      expect(key).toBe('test-public-key');
      expect(secret).toBe('test-private-key');
      expect(config).toEqual({ options: { timeout: 10_000 } });
      return {
        post: (resource: string, options: unknown) => {
          expect(resource).toBe('send');
          expect(options).toEqual({ version: 'v3.1' });
          return {
            request: async (payload: { Messages: Message[] }) => {
              if (state.deliveryFailure) throw state.deliveryFailure;
              state.sentMessages.push(...payload.Messages);
              return { body: { accepted: true } };
            },
          };
        },
      };
    },
  },
}));

beforeEach(() => {
  state.sentMessages.length = 0;
  state.deliveryFailure = null;
  vi.restoreAllMocks();
});

test('delivery preserves recipients, sender overrides, message parts, and response', async () => {
  const result = await sendEmail({
    to: ['one@example.com', 'two@example.com'],
    from: 'custom@example.com',
    fromName: 'Custom sender',
    subject: 'Subject',
    html: '<p>Content</p>',
    text: 'Content',
  });
  expect(result).toEqual({ accepted: true });
  expect(state.sentMessages.at(-1)).toEqual({
    From: { Email: 'custom@example.com', Name: 'Custom sender' },
    To: [{ Email: 'one@example.com' }, { Email: 'two@example.com' }],
    Subject: 'Subject',
    HTMLPart: '<p>Content</p>',
    TextPart: 'Content',
  });
});

test('all OTP variants retain their content, expiry, and ScholarOS branding', async () => {
  for (const [type, subject] of [
    ['sign-in', 'Your ScholarOS sign-in code'],
    ['change-email', 'Confirm your new ScholarOS email'],
    ['email-verification', 'Verify your email for ScholarOS'],
    ['forget-password', 'Your ScholarOS password reset code'],
  ] as const) {
    await sendVerificationOtp({
      email: 'student@example.com',
      type,
      otp: '123456',
    });
    const message = state.sentMessages.at(-1)!;
    expect(message.From).toEqual({
      Email: 'scholaros@example.com',
      Name: 'ScholarOS',
    });
    expect(message.To).toEqual([{ Email: 'student@example.com' }]);
    expect(message.Subject).toBe(subject);
    expect(message.TextPart).toContain('123456');
    expect(message.HTMLPart).toContain('123456');
    expect(message.HTMLPart).toContain('15 minutes');
    expect(message.HTMLPart).not.toContain('Senslop');
  }
});

test('delivery failures are logged and rethrown unchanged', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const error of [
      new Error('Delivery unavailable'),
      'upstream unavailable',
    ]) {
      state.deliveryFailure = error;
      await expect(
        sendVerificationOtp({
          email: 'student@example.com',
          type: 'sign-in',
          otp: '123456',
        }),
      ).rejects.toBe(error);
    }
    expect(log.mock.calls).toEqual([
      ['Mailjet send failed: ', 'Delivery unavailable'],
      ['Mailjet send failed: ', 'Unknown mailjet error.'],
    ]);
  } finally {
    log.mockRestore();
  }
});
