ALTER TABLE "account" DROP CONSTRAINT "account_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT "session_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;
--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;
--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();
--> statement-breakpoint
-- Legacy verification records have opaque IDs; retain their codes and expiry.
ALTER TABLE "verification" ALTER COLUMN "id" TYPE uuid USING (
  CASE WHEN "id" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN "id"::uuid ELSE pg_catalog.gen_random_uuid() END
);
--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
