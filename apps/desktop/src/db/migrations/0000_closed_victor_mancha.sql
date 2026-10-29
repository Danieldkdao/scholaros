CREATE TABLE `settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`step` text DEFAULT 'welcome' NOT NULL,
	`consent` integer DEFAULT false NOT NULL,
	`launch_at_login` integer DEFAULT false NOT NULL,
	`background_sync` integer DEFAULT false NOT NULL,
	`local_setup_completed_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_workspaces` (
	`user_id` text PRIMARY KEY NOT NULL,
	`browser` text NOT NULL,
	`browser_name` text NOT NULL,
	`executable` text NOT NULL,
	`verified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `academic_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`host` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`verified_at` text
);
--> statement-breakpoint
CREATE INDEX `academic_connections_user_idx` ON `academic_connections` (`user_id`);--> statement-breakpoint
CREATE TABLE `academic_context` (
	`user_id` text PRIMARY KEY NOT NULL,
	`primary_lms` text,
	`notes` text DEFAULT '' NOT NULL
);
