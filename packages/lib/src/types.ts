import type { Dispatch, SetStateAction } from 'react';

export type SetterType<T> = Dispatch<SetStateAction<T>>;
