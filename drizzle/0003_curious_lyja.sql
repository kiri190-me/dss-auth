ALTER TABLE "identities" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "totp_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "totp_last_step" integer;