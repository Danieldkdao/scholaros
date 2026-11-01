CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text,
	`source_key` text NOT NULL,
	`source_name` text NOT NULL,
	`source_host` text NOT NULL,
	`external_id` text,
	`name` text NOT NULL,
	`code` text,
	`term` text,
	`instructor` text,
	`description` text,
	`url` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`overview_synced_at` text,
	`announcements_status` text DEFAULT 'pending' NOT NULL,
	`announcements_synced_at` text,
	`assignments_status` text DEFAULT 'pending' NOT NULL,
	`assignments_synced_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courses_user_source_key_idx` ON `courses` (`user_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `courses_user_connection_idx` ON `courses` (`user_id`,`connection_id`);--> statement-breakpoint
CREATE TABLE `course_announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`source_key` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`date_value` text,
	`date_text` text,
	`url` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_announcements_identity_idx` ON `course_announcements` (`user_id`,`course_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `course_announcements_course_idx` ON `course_announcements` (`user_id`,`course_id`);--> statement-breakpoint
CREATE TABLE `course_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`source_key` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`date_value` text,
	`date_text` text,
	`url` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_assignments_identity_idx` ON `course_assignments` (`user_id`,`course_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `course_assignments_course_idx` ON `course_assignments` (`user_id`,`course_id`);--> statement-breakpoint
CREATE TABLE `course_sources` (
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`outcome` text NOT NULL,
	`message` text,
	`last_attempted_at` text NOT NULL,
	`last_successful_at` text,
	PRIMARY KEY(`user_id`, `connection_id`)
);
--> statement-breakpoint
CREATE INDEX `course_sources_user_idx` ON `course_sources` (`user_id`);