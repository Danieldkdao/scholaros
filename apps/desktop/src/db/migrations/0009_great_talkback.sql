CREATE TABLE `navigation_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`course_id` text,
	`purpose` text NOT NULL,
	`destination_url` text NOT NULL,
	`parent_url` text,
	`recipe` text,
	`label` text,
	`evidence` text NOT NULL,
	`status` text DEFAULT 'tentative' NOT NULL,
	`destination_kind` text NOT NULL,
	`observed_at` text NOT NULL,
	`verified_at` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_failure_class` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `navigation_locations_course_identity_idx` ON `navigation_locations` (`user_id`,`connection_id`,`course_id`,`purpose`,`destination_url`) WHERE "navigation_locations"."course_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `navigation_locations_connection_identity_idx` ON `navigation_locations` (`user_id`,`connection_id`,`purpose`,`destination_url`) WHERE "navigation_locations"."course_id" is null;--> statement-breakpoint
CREATE INDEX `navigation_locations_lookup_idx` ON `navigation_locations` (`user_id`,`connection_id`,`course_id`,`purpose`,`status`);