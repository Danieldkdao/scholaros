import type { ComponentProps } from 'react';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { InputOTP, InputOTPGroup, InputOTPSlot } from './input-otp';

type OTPInputProps = Omit<
  ComponentProps<typeof InputOTP>,
  'maxLength' | 'children' | 'render'
> & {
  length?: number;
};

export const OTPInput = ({ length = 6, ...props }: OTPInputProps) => (
  <div className="w-full">
    <InputOTP
      {...props}
      maxLength={length}
      pattern={REGEXP_ONLY_DIGITS}
      containerClassName="w-full"
    >
      <InputOTPGroup className="w-full justify-between gap-2">
        {Array.from({ length }).map((_, index) => (
          <InputOTPSlot
            className="flex-1 h-16! text-2xl font-medium"
            index={index}
            key={index}
          />
        ))}
      </InputOTPGroup>
    </InputOTP>
  </div>
);
