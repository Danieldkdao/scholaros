import type { AcademicDateSchema } from '@scholaros/services/ai/resources/shared';
import { useState } from 'react';
import { format, isValid, parseISO, startOfDay } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { Calendar } from '@scholaros/ui/components/calendar';
import { Input } from '@scholaros/ui/components/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@scholaros/ui/components/popover';

type DateTimePickerProps = {
  sourceDate?: AcademicDateSchema | null;
  id: string;
  value: string;
  onChange: (value: string) => void;
};

const formatDateInputValue = (date: AcademicDateSchema) => {
  switch (date.kind) {
    case 'instant':
      return date.instant;
    case 'date':
      return date.date;
    case 'local':
      return `${date.date}T${date.time}`;
    case 'unresolved':
      return date.original;
  }
};

export const DateTimePicker = ({
  id,
  sourceDate,
  value,
  onChange,
}: DateTimePickerProps) => {
  const [open, setOpen] = useState(false);
  const displayed =
    sourceDate && value === sourceDate.original
      ? formatDateInputValue(sourceDate)
      : value;
  const date = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(displayed)
    ? displayed.slice(0, 10)
    : '';
  const selected = date ? parseISO(date) : undefined;
  const time =
    date && displayed.includes('T')
      ? (displayed.slice(11).match(/^\d{2}:\d{2}(?::\d{2})?/)?.[0] ?? '')
      : '';
  const offset =
    date && displayed.includes('T')
      ? (displayed.match(/(?:Z|[+-]\d{2}:\d{2})$/)?.[0] ?? '')
      : '';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                id={id}
                type="button"
                variant="outline"
                className="w-full justify-start font-normal"
              />
            }
          >
            <CalendarIcon />
            {selected && isValid(selected)
              ? format(selected, 'PPP')
              : 'Pick a date'}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              mode="single"
              disabled={{ before: startOfDay(new Date()) }}
              selected={selected}
              defaultMonth={selected}
              onSelect={(day) => {
                onChange(
                  day
                    ? `${format(day, 'yyyy-MM-dd')}${time ? `T${time}${offset}` : ''}`
                    : '',
                );
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <label htmlFor={`${id}-time`}>Time</label>
        <Input
          id={`${id}-time`}
          type="time"
          step="1"
          min={
            date === format(new Date(), 'yyyy-MM-dd') && !offset
              ? format(new Date(), 'HH:mm:ss')
              : undefined
          }
          aria-label="Time"
          className="w-full text-base"
          disabled={!date}
          value={time}
          onChange={(event) =>
            onChange(
              `${date}${event.target.value ? `T${event.target.value}${offset}` : ''}`,
            )
          }
        />
        <Button
          type="button"
          variant="ghost"
          className="self-end"
          disabled={!value}
          onClick={() => onChange('')}
        >
          Clear
        </Button>
      </div>
      <p className="text-base text-muted-foreground">
        {!date && value
          ? `Source date: ${value}`
          : time
            ? offset
              ? `Time offset ${offset}`
              : 'Timezone unspecified'
            : 'Time is optional.'}
      </p>
    </div>
  );
};
