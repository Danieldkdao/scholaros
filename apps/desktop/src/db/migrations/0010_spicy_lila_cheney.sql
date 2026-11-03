CREATE TABLE `course_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`course_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`source_type` text NOT NULL,
	`content_hash` text,
	`extraction_status` text DEFAULT 'pending' NOT NULL,
	`completeness` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`summary_evidence` text,
	`retrieved_at` text,
	`verified_at` text,
	`content_changed_at` text,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_materials_source_identity_idx` ON `course_materials` (`user_id`,`connection_id`,`course_id`,`source_identity`);--> statement-breakpoint
CREATE INDEX `course_materials_course_idx` ON `course_materials` (`user_id`,`connection_id`,`course_id`,`active`);--> statement-breakpoint
CREATE TABLE `course_material_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`version` text NOT NULL,
	`ordinal` integer NOT NULL,
	`heading` text,
	`locator` text,
	`text` text NOT NULL,
	`source_url` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_material_chunks_version_ordinal_idx` ON `course_material_chunks` (`material_id`,`version`,`ordinal`);--> statement-breakpoint
CREATE INDEX `course_material_chunks_material_version_idx` ON `course_material_chunks` (`material_id`,`version`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `course_material_chunks_fts` USING fts5(
	`id` UNINDEXED,
	`material_id` UNINDEXED,
	`version` UNINDEXED,
	`heading`,
	`text`,
	content='course_material_chunks',
	content_rowid='rowid',
	tokenize='unicode61'
);
--> statement-breakpoint
CREATE TRIGGER `course_material_chunks_fts_insert` AFTER INSERT ON `course_material_chunks` BEGIN
	INSERT INTO `course_material_chunks_fts` (`rowid`,`id`,`material_id`,`version`,`heading`,`text`)
	VALUES (new.rowid,new.id,new.material_id,new.version,new.heading,new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `course_material_chunks_fts_delete` AFTER DELETE ON `course_material_chunks` BEGIN
	INSERT INTO `course_material_chunks_fts` (`course_material_chunks_fts`,`rowid`,`id`,`material_id`,`version`,`heading`,`text`)
	VALUES ('delete',old.rowid,old.id,old.material_id,old.version,old.heading,old.text);
END;
--> statement-breakpoint
CREATE TRIGGER `course_material_chunks_fts_update` AFTER UPDATE ON `course_material_chunks` BEGIN
	INSERT INTO `course_material_chunks_fts` (`course_material_chunks_fts`,`rowid`,`id`,`material_id`,`version`,`heading`,`text`)
	VALUES ('delete',old.rowid,old.id,old.material_id,old.version,old.heading,old.text);
	INSERT INTO `course_material_chunks_fts` (`rowid`,`id`,`material_id`,`version`,`heading`,`text`)
	VALUES (new.rowid,new.id,new.material_id,new.version,new.heading,new.text);
END;
