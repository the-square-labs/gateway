-- Account invitation emails: records when the one-time "an account was created for you" email was sent, so it is
-- offered only while the user has never signed in and was not invited yet.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "invitation_sent_at" timestamp with time zone;
