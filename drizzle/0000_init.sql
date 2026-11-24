CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"arena_id" text NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text,
	"appearance" jsonb,
	"status" text NOT NULL,
	"activity" text,
	"waiting_on" text,
	"waiting_for" text,
	"progress" double precision,
	"result" text,
	"result_truncated" boolean DEFAULT false NOT NULL,
	"error" text,
	"seat" integer NOT NULL,
	"version" bigint NOT NULL,
	"session" text,
	"seq_watermark" double precision,
	"ttl_seconds" integer NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"away_since" bigint,
	"status_changed_at" bigint NOT NULL,
	"metadata" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"arena_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_sealed" text,
	"prefix" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "arenas" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"theme" text NOT NULL,
	"version" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "arenas_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"arena_id" text NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"arena_id" text NOT NULL,
	"agent_key" text NOT NULL,
	"type" text NOT NULL,
	"applied" boolean NOT NULL,
	"report" jsonb,
	"agent_version" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_failures" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "login_failures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client" text NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" bigint NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_arena_key" ON "agents" USING btree ("arena_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_arena_seat" ON "agents" USING btree ("arena_id","seat");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_arena_name" ON "api_keys" USING btree ("arena_id","name");--> statement-breakpoint
CREATE INDEX "changes_created_at" ON "changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_arena_agent_id" ON "events" USING btree ("arena_id","agent_key","id");--> statement-breakpoint
CREATE INDEX "events_created_at" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "login_failures_client_at" ON "login_failures" USING btree ("client","at");--> statement-breakpoint
CREATE INDEX "login_failures_at" ON "login_failures" USING btree ("at");--> statement-breakpoint
CREATE INDEX "rate_limits_window" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
-- The global change counter starts at 0, and nothing has been pruned from the change feed yet.
INSERT INTO "counters" ("name", "value") VALUES ('seq', 0), ('changes_pruned_through', 0) ON CONFLICT ("name") DO NOTHING;
