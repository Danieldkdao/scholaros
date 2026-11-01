import { useState } from 'react';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
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
import type { CourseSummary, SavedCourseChild } from '../types';
import type { UpdateCourseRecordSchema } from '../schemas';

type CourseRecordActionsProps = {
  courseId: string;
  disabled?: boolean;
  onDeleted?: () => void;
} & (
  | { kind: 'courses'; course: CourseSummary }
  | { kind: 'assignments' | 'announcements'; item: SavedCourseChild }
);

export const CourseRecordActions = (props: CourseRecordActionsProps) => {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmation = useConfirm<boolean>();
  const title = props.kind === 'courses' ? props.course.name : props.item.title;
  const label = formatCourseRecordKind(props.kind);
  const target = {
    kind: props.kind,
    courseId: props.courseId,
    id: props.kind === 'courses' ? props.course.id : props.item.id,
  };
  const save = async (input: UpdateCourseRecordSchema) => {
    try {
      await window.scholar.updateCourseRecord(input);
      setEditing(false);
      toast.success('Changes saved');
    } catch (cause) {
      toast.error(errorMessage(cause, 'Could not save changes.'));
    }
  };
  const remove = async () => {
    setDeleting(true);
    try {
      await window.scholar.deleteCourseRecord(target);
      confirmation.cancel();
      toast.success('Record deleted');
      props.onDeleted?.();
    } catch (cause) {
      toast.error(errorMessage(cause, 'Could not delete this record.'));
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
              ? 'Stop the course refresh to edit or delete'
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
            variant="destructive"
            onClick={() => confirmation.request(true)}
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {label}</DialogTitle>
            <DialogDescription>
              Changes are saved locally and may be replaced by a future refresh.
            </DialogDescription>
          </DialogHeader>
          {props.kind === 'courses' ? (
            <CourseRecordEditor
              course={props.course}
              onSave={(values) =>
                save({
                  kind: 'courses',
                  courseId: props.courseId,
                  id: props.course.id,
                  values,
                })
              }
              onCancel={() => setEditing(false)}
            />
          ) : (
            <CourseChildEditor
              kind={props.kind}
              item={props.item}
              onSave={(values) =>
                save({
                  kind: props.kind,
                  courseId: props.courseId,
                  id: props.item.id,
                  values,
                })
              }
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
            <AlertDialogTitle>Delete {title}?</AlertDialogTitle>
            <AlertDialogDescription>
              {props.kind === 'courses'
                ? 'This deletes the saved course, its assignments, and its announcements; a future sync may find them again.'
                : 'This deletes the saved item; a future sync may find it again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void remove()}
            >
              <LoadingSwap isLoading={deleting}>Delete</LoadingSwap>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
