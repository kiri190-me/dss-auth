CREATE TABLE "notification_kind_purposes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_kind_purposes" ADD CONSTRAINT "notification_kind_purposes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_kind_purposes_unique" ON "notification_kind_purposes" USING btree ("client_id","kind");