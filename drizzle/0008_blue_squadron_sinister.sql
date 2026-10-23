CREATE TABLE "approval_mail_kinds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_mail_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"item_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_mail_kinds" ADD CONSTRAINT "approval_mail_kinds_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_mail_deliveries" ADD CONSTRAINT "approval_mail_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_mail_kinds_unique" ON "approval_mail_kinds" USING btree ("client_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_mail_deliveries_unique" ON "approval_mail_deliveries" USING btree ("user_id","client_id","item_id");--> statement-breakpoint
CREATE INDEX "approval_mail_deliveries_sent_at_idx" ON "approval_mail_deliveries" USING btree ("sent_at");