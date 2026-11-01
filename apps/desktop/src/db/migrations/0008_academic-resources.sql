ALTER TABLE `courses` ADD `content` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `content_changed_at` text;--> statement-breakpoint
ALTER TABLE `course_announcements` ADD `content` text;--> statement-breakpoint
ALTER TABLE `course_announcements` ADD `content_changed_at` text;--> statement-breakpoint
ALTER TABLE `course_assignments` ADD `content` text;--> statement-breakpoint
ALTER TABLE `course_assignments` ADD `content_changed_at` text;