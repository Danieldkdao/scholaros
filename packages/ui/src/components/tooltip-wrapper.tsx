"use client";

import type { ComponentProps, ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type TooltipWrapperProps = {
  children: ReactElement;
  content: string;
  tooltipContentProps?: ComponentProps<typeof TooltipContent>;
};

export const TooltipWrapper = ({
  children,
  content,
  tooltipContentProps,
}: TooltipWrapperProps) => (
  <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent {...tooltipContentProps}>{content}</TooltipContent>
  </Tooltip>
);
