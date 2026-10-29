import { z } from 'zod';

export const authFormSchema = z.object({
  name: z.string().trim().max(100, 'Use no more than 100 characters.'),
  email: z.string().trim().pipe(z.email('Enter a valid email address.')),
  password: z
    .string()
    .min(12, 'Use at least 12 characters.')
    .max(128, 'Use no more than 128 characters.'),
});
export type AuthFormSchema = z.infer<typeof authFormSchema>;

export const signUpFormSchema = authFormSchema.extend({
  name: authFormSchema.shape.name.min(1, 'Enter your name.'),
});
export type SignUpFormSchema = z.infer<typeof signUpFormSchema>;

export const verifyAccountSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your email.'),
});
export type VerifyAccountSchema = z.infer<typeof verifyAccountSchema>;
