'use client';

import type { ReactNode } from 'react';
import { ListFilter } from 'lucide-react';
import { Button } from './button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from './popover';
import { TooltipWrapper } from './tooltip-wrapper';

export const FilterPopover = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <Popover>
    <TooltipWrapper content={label}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={label}
            className="shrink-0"
          />
        }
      >
        <ListFilter aria-hidden="true" />
      </PopoverTrigger>
    </TooltipWrapper>
    <PopoverContent
      align="end"
      className="flex max-w-[calc(100vw-2rem)] flex-col gap-4"
    >
      <PopoverTitle className="font-medium">{label}</PopoverTitle>
      {children}
    </PopoverContent>
  </Popover>
);
