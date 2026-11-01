ALTER TABLE `settings` ADD `decision_time_seconds` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `blocked_words` text DEFAULT '[]' NOT NULL;