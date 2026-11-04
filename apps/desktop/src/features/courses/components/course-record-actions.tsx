import { useState } from 'react';
import { EyeOff, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@scholaros/ui/components/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@scholaros/ui/components/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@scholaros/ui/components/alert-dialog';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { toast } from '@scholaros/ui/components/toast';
import { useConfirm } from '../../../hooks/use-confirm';
import { formatCourseRecordKind } from '../lib/formatters';
import { errorMessage } from '../../../lib/error-message';
import { CourseRecordEditor, CourseChildEditor } from './course-record-editor';
import { HiddenCourseRecords } from './hidden-course-records';
import type {
  CourseChildLocalOverrideField,
  CourseLocalOverrideField,
  CourseSummary,
  SavedCourseChild,
} from '../types';
import type { UpdateCourseRecordSchema } from '../schemas';
import type {
  CourseChildLocalOverrideView,
  CourseLocalOverrideView,
  ResetCourseRecordOverridesInput,
} from '../services/store';

type CourseActionRecord = CourseSummary & {
  local?: CourseLocalOverrideView;
};
type CourseChildActionRecord = SavedCourseChild & {
  local?: CourseChildLocalOverrideView;
};
type CourseOverrideBridge = typeof window.scholar & {
  resetCourseRecordOverrides?: (
    input: ResetCourseRecordOverridesInput,
  ) => Promise<void>;
};

type CourseRecordActionsProps = {
  courseId: string;
  disabled?: boolean;
  onDeleted?: () => void;
} & (
  | { kind: 'courses'; course: CourseActionRecord }
  | { kind: 'assignments' | 'announcements'; item: CourseChildActionRecord }
);

export const CourseRecordActions = (props: CourseRecordActionsProps) => {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmation = useConfirm<boolean>();
  const title = props.kind === 'courses' ? props.course.name : props.item.title;
  const label = formatCourseRecordKind(props.kind);
  const local =
    props.kind === 'courses' ? props.course.local : props.item.local;
  const isManual = local?.origin === 'manual';
  const target = {
    kind: props.kind,
    courseId: props.courseId,
    id: props.kind === 'courses' ? props.course.id : props.item.id,
  };
  const deleteLabel = isManual ? 'Delete' : 'Hide';
  const deleteDescription = isManual
    ? props.kind === 'courses'
      ? 'This permanently deletes this manually created course and its local records.'
      : 'This permanently deletes this locally created record.'
    : props.kind === 'courses'
      ? 'This hides the course and its saved records. Restore them later from Hidden records; the source connection will not change.'
      : 'This hides the saved source record. Restore it later from Hidden records; the source connection will not change.';
  const editDescription = isManual
    ? 'Edits apply to this locally created record.'
    : local?.sourceUncertain
      ? 'Edits stay local, but older source values may be unrecoverable.'
      : 'Edits stay local and do not change source identity, official status, or availability.';

  const save = async (input: UpdateCourseRecordSchema) => {
    try {
      await window.scholar.updateCourseRecord(input);
      setEditing(false);
      toast.success('Changes saved locally');
    } catch (cause) {
      toast.error(errorMessage(cause, 'Could not save changes.'));
    }
  };

  const resetOverrides = async (
    fields: CourseLocalOverrideField[] | CourseChildLocalOverrideField[],
  ) => {
    const bridge = window.scholar as CourseOverrideBridge;
    try {
      if (!bridge.resetCourseRecordOverrides)
        throw new Error('Resetting local edits is not available yet.');
      const input: ResetCourseRecordOverridesInput =
        props.kind === 'courses'
          ? {
              kind: 'courses',
              courseId: props.courseId,
              id: props.course.id,
              fields: fields as CourseLocalOverrideField[],
            }
          : {
              kind: props.kind,
              courseId: props.courseId,
              id: props.item.id,
              fields: fields as CourseChildLocalOverrideField[],
            };
      await bridge.resetCourseRecordOverrides(input);
      setEditing(false);
      toast.success('Reset to source');
    } catch (cause) {
      toast.error(errorMessage(cause, 'Could not reset this field.'));
      throw cause;
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await window.scholar.deleteCourseRecord(target);
      confirmation.cancel();
      toast.success(isManual ? 'Record deleted' : 'Record hidden');
      props.onDeleted?.();
    } catch (cause) {
      toast.error(
        errorMessage(
          cause,
          `Could not ${deleteLabel.toLowerCase()} this record.`,
        ),
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <TooltipWrapper
          content={
            props.disabled
              ? `Stop the course refresh to edit or ${deleteLabel.toLowerCase()}`
              : `Actions for ${title}`
          }
        >
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${title}`}
                disabled={props.disabled}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
        </TooltipWrapper>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant={isManual ? 'destructive' : 'default'}
            onClick={() => confirmation.request(true)}
          >
            {isManual ? <Trash2 /> : <EyeOff />}
            {deleteLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {props.kind === 'courses' && (
        <HiddenCourseRecords
          courseId={props.course.id}
          courseTitle={props.course.name}
          connectionId={props.course.connectionId}
          restoreDisabled={props.disabled}
        />
      )}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {label}</DialogTitle>
            <DialogDescription>{editDescription}</DialogDescription>
          </DialogHeader>
          {props.kind === 'courses' ? (
            <CourseRecordEditor
              key={JSON.stringify(props.course.local?.overrides ?? {})}
              course={props.course}
              local={props.course.local}
              onSave={(values) =>
                save({
                  kind: 'courses',
                  courseId: props.courseId,
                  id: props.course.id,
                  values,
                })
              }
              onReset={resetOverrides}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <CourseChildEditor
              key={JSON.stringify(props.item.local?.overrides ?? {})}
              kind={props.kind}
              item={props.item}
              local={props.item.local}
              onSave={(values) =>
                save({
                  kind: props.kind,
                  courseId: props.courseId,
                  id: props.item.id,
                  values,
                })
              }
              onReset={resetOverrides}
              onCancel={() => setEditing(false)}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!confirmation.pending}
        onOpenChange={(open) => {
          if (!open && !deleting) confirmation.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteLabel} {title}?
            </AlertDialogTitle>
            <AlertDialogDescription>{deleteDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button
              variant={isManual ? 'destructive' : 'default'}
              disabled={deleting}
              onClick={() => void remove()}
            >
              <LoadingSwap isLoading={deleting}>{deleteLabel}</LoadingSwap>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
