import { useState } from 'react';

export const useConfirm = <T>() => {
  const [pending, setPending] = useState<T | null>(null);
  return { pending, request: setPending, cancel: () => setPending(null) };
};
