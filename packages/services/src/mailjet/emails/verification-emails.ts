import { serverEnv } from '@scholaros/env/server';
import { sendEmail } from '..';

const APP_NAME = 'ScholarOS';

type SendVerificationOtpProps = {
  email: string;
  type: 'sign-in' | 'change-email' | 'email-verification' | 'forget-password';
  otp: string;
};

const formatVerificationEmail = (type: SendVerificationOtpProps['type']) => {
  switch (type) {
    case 'sign-in':
      return {
        subject: `Your ${APP_NAME} sign-in code`,
        heading: 'Use this code to sign in',
        description: `Enter the verification code below to finish signing in to your ${APP_NAME} account.`,
        instruction: 'Paste this code into the sign-in screen to continue.',
      };
    case 'change-email':
      return {
        subject: `Confirm your new ${APP_NAME} email`,
        heading: 'Confirm your new email',
        description: `Use the verification code below to confirm this email address for your ${APP_NAME} account.`,
        instruction: 'Enter this code to complete your email change.',
      };
    case 'email-verification':
      return {
        subject: `Verify your email for ${APP_NAME}`,
        heading: 'Verify your email',
        description: `Welcome to ${APP_NAME}. Enter the verification code below to activate your account.`,
        instruction:
          'Type this code into the verification form to finish setup.',
      };
    case 'forget-password':
      return {
        subject: `Your ${APP_NAME} password reset code`,
        heading: 'Reset your password',
        description: `Use the verification code below to continue resetting your ${APP_NAME} password.`,
        instruction: 'Enter this code on the password reset screen to proceed.',
      };
    default:
      throw new Error(`Unsupported email type: ${type satisfies never}`);
  }
};

export const sendVerificationOtp = async ({
  email,
  type,
  otp,
}: SendVerificationOtpProps) => {
  const { description, heading, instruction, subject } =
    formatVerificationEmail(type);
  const text = [
    `${heading} - ${APP_NAME}`,
    '',
    description,
    '',
    `Verification code: ${otp}`,
    instruction,
    '',
    'If you did not request this email, you can safely ignore it.',
  ].join('\n');

  // Email clients require inline delivery styles rather than app theme utilities.
  const html = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    </head>

    <body
      style="
        margin: 0;
        padding: 0;
        background-color: #ffffff;
        color: #0a0a0a;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
          Arial, sans-serif;
        letter-spacing: -0.015em;
      "
    >
      <div
        style="
          background-color: #ffffff;
          margin: 0;
          padding: 32px 16px;
          width: 100%;
          box-sizing: border-box;
        "
      >
        <div
          style="
            max-width: 560px;
            margin: 0 auto;
            width: 100%;
            box-sizing: border-box;
          "
        >
          <div style="padding: 32px 32px 20px 32px; text-align: center">
            <h1
              style="
                margin: 0;
                color: #0a0a0a;
                font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Arial, sans-serif;
                font-size: 32px;
                line-height: 1.15;
                font-weight: 700;
                letter-spacing: -0.03em;
              "
            >
              ${heading}
            </h1>

            <p
              style="
                margin: 14px 0 0 0;
                color: #737373;
                font-size: 16px;
                line-height: 1.6;
              "
            >
              ${instruction}
            </p>
          </div>

          <div style="padding: 12px 32px 28px 32px">
            <div
              style="
                color: #171717;
                font-size: 40px;
                line-height: 1;
                font-weight: 800;
                letter-spacing: 0.18em;
                font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
                  'Segoe UI', Arial, sans-serif;
                text-align: center;
              "
            >
              ${otp}
            </div>
          </div>

          <div style="padding: 0 32px 32px 32px">
            <p
              style="
                margin: 0;
                color: #404040;
                font-size: 15px;
                line-height: 1.7;
                text-align: center;
              "
            >
              This code will expire in
              <strong>15 minutes</strong>. Do not share this code with anyone.
            </p>

            <p
              style="
                margin: 16px 0 0 0;
                color: #737373;
                font-size: 14px;
                line-height: 1.7;
                text-align: center;
              "
            >
              If you did not request this code, you can safely ignore this email.
            </p>
          </div>

          <div style="padding: 0 32px">
            <div
              style="
                height: 1px;
                background-color: #e5e5e5;
                line-height: 1px;
                font-size: 1px;
              "
            >
              &nbsp;
            </div>
          </div>

          <div style="padding: 24px 32px 32px 32px; text-align: center">
            <p
              style="
                margin: 0;
                color: #737373;
                font-size: 13px;
                line-height: 1.6;
              "
            >
              Sent by ${APP_NAME}
            </p>

            <p
              style="
                margin: 8px 0 0 0;
                color: #737373;
                font-size: 12px;
                line-height: 1.6;
              "
            >
              This is an automated message. Please do not reply.
            </p>

            <p
              style="
                margin: 8px 0 0 0;
                color: #737373;
                font-size: 12px;
                line-height: 1.6;
              "
            >
              © 2026 ${APP_NAME}. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </body>
  </html>`;

  await sendEmail({
    from: serverEnv.SENDER_EMAIL,
    to: email,
    subject,
    html,
    text,
  });
};
