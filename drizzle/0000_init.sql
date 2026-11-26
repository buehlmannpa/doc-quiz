CREATE TYPE "public"."question_type" AS ENUM('multiple_choice', 'estimate', 'poll');--> statement-breakpoint
CREATE TYPE "public"."quiz_status" AS ENUM('draft', 'ready', 'completed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('lobby', 'running', 'finished', 'cancelled');--> statement-breakpoint
CREATE TABLE "answer_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"is_correct" boolean DEFAULT false NOT NULL,
	CONSTRAINT "answer_options_position_range" CHECK ("answer_options"."position" between 0 and 3),
	CONSTRAINT "answer_options_text_length" CHECK (char_length("answer_options"."text") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "game_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"join_code" text NOT NULL,
	"status" "session_status" DEFAULT 'lobby' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "game_sessions_join_code_format" CHECK ("game_sessions"."join_code" ~ '^[0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"avatar" smallint DEFAULT 0 NOT NULL,
	"token_hash" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_points" integer,
	"total_answer_time_ms" integer,
	"final_rank" integer,
	CONSTRAINT "players_name_length" CHECK (char_length("players"."name") between 1 and 20),
	CONSTRAINT "players_avatar_range" CHECK ("players"."avatar" between 0 and 63)
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" "question_type" NOT NULL,
	"prompt" text NOT NULL,
	"time_limit_seconds" integer DEFAULT 20 NOT NULL,
	"max_points" integer DEFAULT 1000 NOT NULL,
	"correct_value" double precision,
	"unit" text,
	"tolerance" double precision,
	CONSTRAINT "questions_position_nonneg" CHECK ("questions"."position" >= 0),
	CONSTRAINT "questions_prompt_length" CHECK (char_length("questions"."prompt") between 1 and 300),
	CONSTRAINT "questions_time_limit_range" CHECK ("questions"."time_limit_seconds" between 5 and 120),
	CONSTRAINT "questions_max_points_range" CHECK ("questions"."max_points" between 0 and 10000),
	CONSTRAINT "questions_estimate_fields" CHECK (("questions"."type" = 'estimate' and "questions"."correct_value" is not null and "questions"."tolerance" is not null and "questions"."tolerance" > 0)
        or ("questions"."type" <> 'estimate' and "questions"."correct_value" is null and "questions"."tolerance" is null and "questions"."unit" is null)),
	CONSTRAINT "questions_poll_no_points" CHECK ("questions"."type" <> 'poll' or "questions"."max_points" = 0)
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "quiz_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quizzes_title_length" CHECK (char_length("quizzes"."title") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"option_id" uuid,
	"numeric_value" double precision,
	"answer_time_ms" integer NOT NULL,
	"points_awarded" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responses_answer_time_nonneg" CHECK ("responses"."answer_time_ms" >= 0),
	CONSTRAINT "responses_option_xor_value" CHECK (("responses"."option_id" is not null) <> ("responses"."numeric_value" is not null))
);
--> statement-breakpoint
ALTER TABLE "answer_options" ADD CONSTRAINT "answer_options_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_option_id_answer_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."answer_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_options_question_position_idx" ON "answer_options" USING btree ("question_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "game_sessions_active_join_code_idx" ON "game_sessions" USING btree ("join_code") WHERE "game_sessions"."status" in ('lobby', 'running');--> statement-breakpoint
CREATE INDEX "game_sessions_quiz_idx" ON "game_sessions" USING btree ("quiz_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_session_name_idx" ON "players" USING btree ("session_id",lower("name"));--> statement-breakpoint
CREATE INDEX "questions_quiz_position_idx" ON "questions" USING btree ("quiz_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_player_question_idx" ON "responses" USING btree ("player_id","question_id");--> statement-breakpoint
CREATE INDEX "responses_session_question_idx" ON "responses" USING btree ("session_id","question_id");