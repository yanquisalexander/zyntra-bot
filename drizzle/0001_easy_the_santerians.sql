CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"plugin_name" text NOT NULL,
	"ok" boolean,
	"duration_ms" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now(),
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_name" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"expr" text NOT NULL,
	"description" text,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"skips" integer DEFAULT 0 NOT NULL,
	"last_ok" boolean,
	"last_error" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "job_runs_started_idx" ON "job_runs" USING btree ("started_at");