CREATE TABLE `course_record_tombstones` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`course_source_key` text NOT NULL,
	`kind` text NOT NULL,
	`resource_source_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_record_tombstones_identity_idx` ON `course_record_tombstones` (`user_id`,`connection_id`,`course_source_key`,`kind`,`resource_source_key`);--> statement-breakpoint
CREATE INDEX `course_record_tombstones_scope_idx` ON `course_record_tombstones` (`user_id`,`connection_id`,`course_source_key`);