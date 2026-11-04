import type { RefObject } from 'react';
import { FileText, ImagePlus, Lightbulb, Plus, Upload } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@scholaros/ui/components/dropdown-menu';

type ContextAddMenuProps = {
  disabled?: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onCreateNote: () => void;
  onCreatePreference: () => void;
  onImport: () => void;
};

export const ContextAddMenu = ({
  disabled = false,
  triggerRef,
  onCreateNote,
  onCreatePreference,
  onImport,
}: ContextAddMenuProps) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <Button
          ref={triggerRef}
          aria-label="Add to Context"
          disabled={disabled}
        >
          <Plus aria-hidden="true" />
          Add to Context
        </Button>
      }
    />
    <DropdownMenuContent align="end" className="w-auto">
      <DropdownMenuItem
        disabled={disabled}
        onClick={() => {
          if (!disabled) onCreateNote();
        }}
      >
        <FileText aria-hidden="true" />
        Text or note
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={disabled}
        onClick={() => {
          if (!disabled) onCreatePreference();
        }}
      >
        <Lightbulb aria-hidden="true" />
        Personal preference or context
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={disabled}
        onClick={() => {
          if (!disabled) onImport();
        }}
      >
        <Upload aria-hidden="true" />
        Document or PDF
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={disabled}
        onClick={() => {
          if (!disabled) onImport();
        }}
      >
        <ImagePlus aria-hidden="true" />
        Image or screenshot
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
