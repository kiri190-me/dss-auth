CREATE TABLE "approval_inbox_views" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_inbox_views" ADD CONSTRAINT "approval_inbox_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;