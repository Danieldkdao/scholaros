CREATE TABLE `context_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`provenance` text NOT NULL,
	`current_version_id` text,
	`status` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`removed_at` text,
	`originating_session_id` text,
	`originating_source_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_items_user_updated_idx` ON `context_items` (`user_id`,`removed_at`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `context_items_current_version_idx` ON `context_items` (`current_version_id`);--> statement-breakpoint
CREATE TABLE `context_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`original_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`original_storage_key` text,
	`extracted_text` text,
	`extraction_status` text NOT NULL,
	`uncertainty` text,
	`page_count` integer,
	`interpreted_pages` text DEFAULT '[]' NOT NULL,
	`locators` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_versions_item_attempt_idx` ON `context_versions` (`item_id`,`attempt_id`);--> statement-breakpoint
CREATE INDEX `context_versions_item_original_idx` ON `context_versions` (`user_id`,`item_id`,`original_hash`);--> statement-breakpoint
CREATE INDEX `context_versions_content_hash_idx` ON `context_versions` (`user_id`,`content_hash`);--> statement-breakpoint
CREATE TRIGGER `context_versions_immutable` BEFORE UPDATE ON `context_versions` BEGIN
  SELECT RAISE(ABORT, 'context versions are immutable');
END;--> statement-breakpoint
CREATE TABLE `context_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`course_id` text,
	`session_id` text,
	`retained_in_library` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_links_course_scope_idx` ON `context_links` (`user_id`,`item_id`,`course_id`) WHERE "context_links"."course_id" is not null and "context_links"."session_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `context_links_session_scope_idx` ON `context_links` (`user_id`,`item_id`,`session_id`) WHERE "context_links"."course_id" is null and "context_links"."session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `context_links_course_session_scope_idx` ON `context_links` (`user_id`,`item_id`,`course_id`,`session_id`) WHERE "context_links"."course_id" is not null and "context_links"."session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `context_links_library_scope_idx` ON `context_links` (`user_id`,`item_id`) WHERE "context_links"."course_id" is null and "context_links"."session_id" is null;--> statement-breakpoint
CREATE INDEX `context_links_user_course_idx` ON `context_links` (`user_id`,`course_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `context_links_session_idx` ON `context_links` (`user_id`,`session_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `context_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`version_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`locator` text,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_chunks_version_ordinal_idx` ON `context_chunks` (`version_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `context_chunks_scope_idx` ON `context_chunks` (`user_id`,`item_id`,`version_id`);--> statement-breakpoint
CREATE TABLE `study_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`title` text NOT NULL,
	`activity` text NOT NULL,
	`target_assignment_id` text,
	`topic` text,
	`status` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`generation_epoch` integer DEFAULT 0 NOT NULL,
	`draft_text` text DEFAULT '' NOT NULL,
	`draft_revision` integer DEFAULT 0 NOT NULL,
	`deadline_at` text,
	`timer_revision` integer DEFAULT 0 NOT NULL,
	`expired_revision` integer,
	`resolved_expired_revision` integer,
	`finished_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_opened_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `study_sessions_user_course_status_idx` ON `study_sessions` (`user_id`,`course_id`,`status`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `study_sessions_user_updated_idx` ON `study_sessions` (`user_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `study_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`parts` text NOT NULL,
	`grade_derived` integer DEFAULT false NOT NULL,
	`grade_consent_revision` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `study_messages_session_sequence_idx` ON `study_messages` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `study_messages_user_session_idx` ON `study_messages` (`user_id`,`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `study_messages_grade_derived_idx` ON `study_messages` (`user_id`,`grade_derived`,`grade_consent_revision`);--> statement-breakpoint
CREATE TABLE `study_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`generation_epoch` integer NOT NULL,
	`status` text NOT NULL,
	`attempt_number` integer DEFAULT 1 NOT NULL,
	`policy_revision` integer NOT NULL,
	`context_revision` integer NOT NULL,
	`error_code` text,
	`started_at` text NOT NULL,
	`settled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `study_turns_request_idx` ON `study_turns` (`user_id`,`session_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `study_turns_session_status_idx` ON `study_turns` (`user_id`,`session_id`,`status`);--> statement-breakpoint
CREATE TABLE `study_source_references` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`version_id` text,
	`locator` text,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `study_source_references_scope_idx` ON `study_source_references` (`user_id`,`session_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text,
	`current_version_id` text,
	`originating_session_id` text,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`retained` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`removed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_user_course_idx` ON `artifacts` (`user_id`,`course_id`,`removed_at`);--> statement-breakpoint
CREATE INDEX `artifacts_session_idx` ON `artifacts` (`user_id`,`originating_session_id`);--> statement-breakpoint
CREATE TABLE `artifact_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`user_id` text NOT NULL,
	`content_digest` text NOT NULL,
	`html` text NOT NULL,
	`css` text NOT NULL,
	`javascript` text NOT NULL,
	`runtime_version` integer NOT NULL,
	`source_references` text NOT NULL,
	`policy_decision` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifact_versions_artifact_created_idx` ON `artifact_versions` (`user_id`,`artifact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `artifact_versions_digest_idx` ON `artifact_versions` (`user_id`,`content_digest`);--> statement-breakpoint
CREATE TRIGGER `artifact_versions_immutable` BEFORE UPDATE ON `artifact_versions` BEGIN
  SELECT RAISE(ABORT, 'artifact versions are immutable');
END;--> statement-breakpoint
CREATE TABLE `artifact_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`version_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`state_revision` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_states_attempt_idx` ON `artifact_states` (`artifact_id`,`version_id`,`attempt_id`);--> statement-breakpoint
CREATE INDEX `artifact_states_user_updated_idx` ON `artifact_states` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `practice_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`session_id` text,
	`artifact_id` text,
	`version_id` text NOT NULL,
	`objective_ids` text DEFAULT '[]' NOT NULL,
	`mode` text NOT NULL,
	`feedback_mode` text NOT NULL,
	`status` text NOT NULL,
	`assisted` integer DEFAULT false NOT NULL,
	`prior_attempt_id` text,
	`rubric_version` text NOT NULL,
	`question_set` text NOT NULL,
	`host_answer_key` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`submitted_at` text
);
--> statement-breakpoint
CREATE INDEX `practice_attempts_user_course_status_idx` ON `practice_attempts` (`user_id`,`course_id`,`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `practice_attempts_session_idx` ON `practice_attempts` (`user_id`,`session_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `practice_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` text NOT NULL,
	`revision` integer NOT NULL,
	`answer` text NOT NULL,
	`assisted` integer DEFAULT false NOT NULL,
	`evaluation` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `practice_answers_revision_idx` ON `practice_answers` (`attempt_id`,`question_id`,`revision`);--> statement-breakpoint
CREATE INDEX `practice_answers_user_attempt_idx` ON `practice_answers` (`user_id`,`attempt_id`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`provenance` text NOT NULL,
	`evidence_ids` text DEFAULT '[]' NOT NULL,
	`confidence` real,
	`revision` integer DEFAULT 0 NOT NULL,
	`supersedes_id` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_user_type_updated_idx` ON `memories` (`user_id`,`type`,`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `memories_user_course_idx` ON `memories` (`user_id`,`course_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`label` text NOT NULL,
	`normalized_label` text NOT NULL,
	`description` text NOT NULL,
	`source_references` text DEFAULT '[]' NOT NULL,
	`uncertainty` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `concepts_user_course_label_idx` ON `concepts` (`user_id`,`course_id`,`normalized_label`);--> statement-breakpoint
CREATE TABLE `concept_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`from_concept_id` text NOT NULL,
	`to_concept_id` text NOT NULL,
	`relationship` text NOT NULL,
	`source_references` text DEFAULT '[]' NOT NULL,
	`uncertainty` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `concept_links_identity_idx` ON `concept_links` (`user_id`,`course_id`,`from_concept_id`,`to_concept_id`,`relationship`);--> statement-breakpoint
CREATE INDEX `concept_links_from_idx` ON `concept_links` (`user_id`,`course_id`,`from_concept_id`);--> statement-breakpoint
CREATE INDEX `concept_links_to_idx` ON `concept_links` (`user_id`,`course_id`,`to_concept_id`);--> statement-breakpoint
CREATE TABLE `learning_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`concept_id` text,
	`attempt_id` text,
	`source_session_id` text,
	`kind` text NOT NULL,
	`response_outcome` text NOT NULL,
	`assisted` integer NOT NULL,
	`independent_evidence` integer DEFAULT false NOT NULL,
	`confidence` real,
	`evidence_summary` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `learning_observations_user_course_created_idx` ON `learning_observations` (`user_id`,`course_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `learning_observations_attempt_idx` ON `learning_observations` (`user_id`,`attempt_id`);--> statement-breakpoint
CREATE TABLE `grade_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`course_id` text NOT NULL,
	`assignment_identity` text NOT NULL,
	`source_version` text NOT NULL,
	`observed_at` text NOT NULL,
	`consent_revision` integer NOT NULL,
	`completed` text NOT NULL,
	`grade` text,
	`remaining_opportunity` text NOT NULL,
	`conflicts` text DEFAULT '[]' NOT NULL,
	`source_references` text DEFAULT '[]' NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `grade_evidence_user_consent_idx` ON `grade_evidence` (`user_id`,`consent_revision`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `grade_evidence_assignment_idx` ON `grade_evidence` (`user_id`,`connection_id`,`course_id`,`assignment_identity`,`observed_at`);--> statement-breakpoint
CREATE TABLE `coursework_protections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`connection_id` text,
	`canonical_identity` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`question_fingerprint` text,
	`state` text DEFAULT 'unknown' NOT NULL,
	`policy_revision` integer DEFAULT 0 NOT NULL,
	`verified_at` text,
	`source_evidence_id` text,
	`suppressed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coursework_protections_identity_idx` ON `coursework_protections` (`user_id`,`course_id`,`canonical_identity`);--> statement-breakpoint
CREATE INDEX `coursework_protections_scope_idx` ON `coursework_protections` (`user_id`,`connection_id`,`course_id`,`suppressed`);--> statement-breakpoint
CREATE TABLE `assistance_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`protection_id` text NOT NULL,
	`question_fingerprint` text NOT NULL,
	`turn_id` text,
	`allowed_support_summary` text NOT NULL,
	`answer_risk_tags` text DEFAULT '[]' NOT NULL,
	`assistance_units` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assistance_ledger_protection_created_idx` ON `assistance_ledger` (`user_id`,`protection_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `assistance_ledger_question_idx` ON `assistance_ledger` (`user_id`,`course_id`,`question_fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistance_ledger_turn_identity_idx` ON `assistance_ledger` (`user_id`,`course_id`,`protection_id`,`question_fingerprint`,`turn_id`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text,
	`outcome_id` text NOT NULL,
	`preference_revision` integer NOT NULL,
	`status` text NOT NULL,
	`deliver_after` text,
	`expires_at` text NOT NULL,
	`claimed_at` text,
	`delivered_at` text,
	`safe_route` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_outcome_idx` ON `notification_events` (`user_id`,`category`,`outcome_id`);--> statement-breakpoint
CREATE INDEX `notification_events_due_idx` ON `notification_events` (`user_id`,`status`,`deliver_after`,`expires_at`);--> statement-breakpoint
CREATE INDEX `notification_events_target_idx` ON `notification_events` (`user_id`,`target_kind`,`target_id`,`status`);--> statement-breakpoint
ALTER TABLE `settings` ADD `product_preferences` text DEFAULT '{"grades":{"enabled":false,"notes":"","revision":0},"notifications":{"enabled":false,"categories":{"connection-attention":false,"sync-completed":false,"sync-failed":false,"context-completed":false,"context-failed":false,"tutor-ready":false,"activity-ready":false,"timer-expired":false,"deadline-reminder":false},"quietHours":{"enabled":false,"startMinute":1320,"endMinute":480,"timeZone":"UTC"},"revision":0},"learning":{"educationLevel":null,"appearance":"system","accessibility":{"reduceMotion":false,"highContrast":false},"revision":0}}' NOT NULL;--> statement-breakpoint
ALTER TABLE `course_announcements` ADD `identity_conflicts` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `course_assignments` ADD `identity_conflicts` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `course_materials` ADD `last_attempt_at` text;--> statement-breakpoint
CREATE VIRTUAL TABLE `context_chunks_fts` USING fts5(
  `id` UNINDEXED,
  `user_id` UNINDEXED,
  `item_id` UNINDEXED,
  `version_id` UNINDEXED,
  `ordinal` UNINDEXED,
  `text`,
  content='context_chunks',
  content_rowid='rowid',
  tokenize='unicode61'
);--> statement-breakpoint
CREATE TRIGGER `context_chunks_fts_insert` AFTER INSERT ON `context_chunks` BEGIN
  INSERT INTO `context_chunks_fts` (`rowid`,`id`,`user_id`,`item_id`,`version_id`,`ordinal`,`text`)
  VALUES (new.rowid,new.id,new.user_id,new.item_id,new.version_id,new.ordinal,new.text);
END;--> statement-breakpoint
CREATE TRIGGER `context_chunks_fts_delete` AFTER DELETE ON `context_chunks` BEGIN
  INSERT INTO `context_chunks_fts` (`context_chunks_fts`,`rowid`,`id`,`user_id`,`item_id`,`version_id`,`ordinal`,`text`)
  VALUES ('delete',old.rowid,old.id,old.user_id,old.item_id,old.version_id,old.ordinal,old.text);
END;--> statement-breakpoint
CREATE TRIGGER `context_chunks_fts_update` AFTER UPDATE ON `context_chunks` BEGIN
  INSERT INTO `context_chunks_fts` (`context_chunks_fts`,`rowid`,`id`,`user_id`,`item_id`,`version_id`,`ordinal`,`text`)
  VALUES ('delete',old.rowid,old.id,old.user_id,old.item_id,old.version_id,old.ordinal,old.text);
  INSERT INTO `context_chunks_fts` (`rowid`,`id`,`user_id`,`item_id`,`version_id`,`ordinal`,`text`)
  VALUES (new.rowid,new.id,new.user_id,new.item_id,new.version_id,new.ordinal,new.text);
END;