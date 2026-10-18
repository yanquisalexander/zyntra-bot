CREATE TABLE "plugin_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"code" text NOT NULL,
	"config_toml" text NOT NULL,
	"label" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "plugin_revisions" ADD CONSTRAINT "plugin_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_revisions_plugin_id_idx" ON "plugin_revisions" USING btree ("plugin_id","created_at");