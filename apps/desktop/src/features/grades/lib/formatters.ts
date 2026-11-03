import { CircleCheck, CircleHelp, CircleX } from 'lucide-react';
import type { GradeVerificationState } from '@scholaros/services/learning/grade-contracts';

export const formatGradeVerificationState = (state: GradeVerificationState) => {
  switch (state) {
    case 'active':
      return { label: 'Active coursework', Icon: CircleX };
    case 'unknown':
      return { label: 'Completion unverified', Icon: CircleHelp };
    case 'verified-completed':
      return { label: 'Completed and graded', Icon: CircleCheck };
  }
};

export const formatGradeAccessStatus = (enabled: boolean) =>
  enabled
    ? { label: 'Grade access is on', Icon: CircleCheck }
    : { label: 'Grade access is off', Icon: CircleHelp };
