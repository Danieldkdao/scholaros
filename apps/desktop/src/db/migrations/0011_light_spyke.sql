CREATE TABLE `watch_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`course_id` text,
	`requested_url` text NOT NULL,
	`verified_url` text,
	`url_identity` text NOT NULL,
	`last_attempt_at` text,
	`last_successful_check_at` text,
	`detected_fingerprint` text,
	`processed_fingerprint` text,
	`pending_change` integer DEFAULT false NOT NULL,
	`next_check_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`retry_at` text,
	`recipe_version` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_targets_identity_idx` ON `watch_targets` (`user_id`,`connection_id`,`url_identity`);--> statement-breakpoint
CREATE INDEX `watch_targets_due_idx` ON `watch_targets` (`user_id`,`status`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `watch_targets_course_idx` ON `watch_targets` (`user_id`,`connection_id`,`course_id`);--> statement-breakpoint
ALTER TABLE `settings` ADD `watch_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `watch_urls` text DEFAULT '[]' NOT NULL;