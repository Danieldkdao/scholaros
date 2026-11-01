import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@scholaros/ui/components/dialog';
import { toast } from '@scholaros/ui/components/toast';
import { CourseRecordEditor, CourseChildEditor } from './course-record-editor';
import { formatCourseRecordKind } from '../lib/formatters';
import { errorMessage } from '../../../lib/error-message';
import type { CreateCourseRecordSchema } from '../schemas';

type CourseCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & (
  | { kind: 'courses' }
  | { kind: 'assignments' | 'announcements'; courseId: string }
);

export const CourseCreateDialog = (props: CourseCreateDialogProps) => {
  const save = async (input: CreateCourseRecordSchema) => {
    try {
      await window.scholar.createCourseRecord(input);
      props.onOpenChange(false);
      toast.success('Record added');
    } catch (cause) {
      toast.error(errorMessage(cause, 'Could not add this record.'));
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {formatCourseRecordKind(props.kind)}</DialogTitle>
          <DialogDescription>
            Manual records are saved locally.
          </DialogDescription>
        </DialogHeader>
        {props.kind === 'courses' ? (
          <CourseRecordEditor
            onSave={(values) => save({ kind: 'courses', values })}
            onCancel={() => props.onOpenChange(false)}
          />
        ) : (
          <CourseChildEditor
            kind={props.kind}
            onSave={(values) =>
              save({ kind: props.kind, courseId: props.courseId, values })
            }
            onCancel={() => props.onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
