CREATE TABLE `academic_context_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`role` text NOT NULL,
	`evidence_url` text NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `academic_context_entries_user_idx` ON `academic_context_entries` (`user_id`);--> statement-breakpoint
CREATE INDEX `academic_context_entries_connection_idx` ON `academic_context_entries` (`connection_id`);--> statement-breakpoint
ALTER TABLE `academic_context` ADD `discovery_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `academic_context` ADD `discovery_message` text;--> statement-breakpoint
ALTER TABLE `academic_context` ADD `discovered_at` text;