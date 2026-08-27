ALTER TABLE "clients" ADD COLUMN "available_roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_client_grants" ADD COLUMN "role" text;