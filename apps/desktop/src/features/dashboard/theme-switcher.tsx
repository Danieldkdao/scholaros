import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Button } from '@scholaros/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@scholaros/ui/components/dropdown-menu';
import { formatTheme } from './lib/formatters';
import { themePreference, themes } from './lib/themes';

export const ThemeSwitcher = () => {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // next-themes resolves the stored preference in an effect, so the first paint
  // reports nothing and the control falls back to the provider default.
  const current = themePreference(mounted ? theme : undefined);
  const { label, Icon } = formatTheme(current);
  return (
    <DropdownMenu>
      <TooltipWrapper content={`Theme ${label}`}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Theme ${label}`}
            />
          }
        >
          <Icon />
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-auto min-w-32 text-base"
      >
        <DropdownMenuRadioGroup
          aria-label="Theme"
          value={current}
          onValueChange={(value) => setTheme(String(value))}
        >
          {themes.map((option) => {
            const formatted = formatTheme(option);
            return (
              <DropdownMenuRadioItem key={option} value={option} closeOnClick>
                <formatted.Icon />
                {formatted.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
