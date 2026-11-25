ALTER TABLE "arenas" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "changes" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
CREATE INDEX "arenas_owner_user_id" ON "arenas" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "changes_owner_seq" ON "changes" USING btree ("owner_user_id","seq");