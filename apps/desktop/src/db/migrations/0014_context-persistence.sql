CREATE TABLE `course_material_versions` (
	`material_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`title` text,
	`source_url` text,
	`source_type` text,
	`extraction_status` text,
	`completeness` integer,
	`summary` text,
	`summary_evidence` text,
	`retrieved_at` text,
	`verified_at` text,
	`content_changed_at` text,
	PRIMARY KEY(`material_id`, `content_hash`)
);
--> statement-breakpoint
CREATE INDEX `course_material_versions_material_idx` ON `course_material_versions` (`material_id`);--> statement-breakpoint
ALTER TABLE `courses` ADD `local_overrides` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `local_edited_at` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `suppression_id` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `suppressed_at` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `materials_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `courses` ADD `materials_attempted_at` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `materials_synced_at` text;--> statement-breakpoint
ALTER TABLE `course_announcements` ADD `local_overrides` text;--> statement-breakpoint
ALTER TABLE `course_announcements` ADD `local_edited_at` text;--> statement-breakpoint
ALTER TABLE `course_announcements` ADD `suppression_id` text;--> statement-breakpoint
ALTER TABLE `course_announcements` ADD `suppressed_at` text;--> statement-breakpoint
ALTER TABLE `course_assignments` ADD `local_overrides` text;--> statement-breakpoint
ALTER TABLE `course_assignments` ADD `local_edited_at` text;--> statement-breakpoint
ALTER TABLE `course_assignments` ADD `suppression_id` text;--> statement-breakpoint
ALTER TABLE `course_assignments` ADD `suppressed_at` text;--> statement-breakpoint
ALTER TABLE `course_materials` ADD `current_usable_version` text;--> statement-breakpoint
ALTER TABLE `course_materials` ADD `suppression_id` text;--> statement-breakpoint
ALTER TABLE `course_materials` ADD `suppressed_at` text;--> statement-breakpoint
ALTER TABLE `course_record_tombstones` ADD `suppression_id` text;--> statement-breakpoint
CREATE INDEX `course_record_tombstones_group_idx` ON `course_record_tombstones` (`user_id`,`connection_id`,`course_source_key`,`kind`,`suppression_id`);--> statement-breakpoint
ALTER TABLE `watch_targets` ADD `pending_since` text;--> statement-breakpoint
ALTER TABLE `watch_targets` ADD `pending_since_estimated` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `watch_targets` ADD `last_failure_category` text;--> statement-breakpoint
UPDATE `watch_targets`
SET `pending_since` = `updated_at`, `pending_since_estimated` = true
WHERE `pending_change` = true;--> statement-breakpoint
INSERT INTO `course_material_versions` (
  `material_id`,
  `content_hash`,
  `title`,
  `source_url`,
  `source_type`,
  `extraction_status`,
  `completeness`,
  `summary`,
  `summary_evidence`,
  `retrieved_at`,
  `verified_at`,
  `content_changed_at`
)
SELECT DISTINCT
  chunks.`material_id`,
  chunks.`version`,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`title` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`url` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`source_type` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`extraction_status` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`completeness` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`summary` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`summary_evidence` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`retrieved_at` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`verified_at` END,
  CASE WHEN chunks.`version` = materials.`content_hash` THEN materials.`content_changed_at` END
FROM `course_material_chunks` AS chunks
LEFT JOIN `course_materials` AS materials ON materials.`id` = chunks.`material_id`;--> statement-breakpoint
UPDATE `course_materials`
SET `current_usable_version` = `content_hash`
WHERE `content_hash` IS NOT NULL
  AND `extraction_status` IN ('complete', 'partial')
  AND EXISTS (
    SELECT 1
    FROM `course_material_chunks`
    WHERE `course_material_chunks`.`material_id` = `course_materials`.`id`
      AND `course_material_chunks`.`version` = `course_materials`.`content_hash`
  );