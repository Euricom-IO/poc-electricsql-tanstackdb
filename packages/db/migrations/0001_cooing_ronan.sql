CREATE TABLE "processed_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"op" text NOT NULL,
	"user_id" uuid NOT NULL,
	"txid" bigint NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;