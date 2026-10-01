-- A database default for the Pages preview hash. Gateway sets the hash itself, but a release before v2.11 that an
-- updater rolls back to (it restores no database) inserts Projects without one, and the column is NOT NULL since 0206.
-- Same generator as the 0206 backfill: 12 lowercase base32 characters, each taking 5 bits of one byte of a fresh
-- gen_random_uuid() (bytes 0-5 and 10-15 carry no version or variant bits).
CREATE OR REPLACE FUNCTION gateway_page_preview_hash()
RETURNS varchar(12)
LANGUAGE sql
VOLATILE
AS $$
  SELECT string_agg(
    substr('abcdefghijklmnopqrstuvwxyz234567', (get_byte(uuid_send(gen_random_uuid()), "bytes"."byte_index") % 32) + 1, 1),
    '' ORDER BY "bytes"."position"
  )::varchar(12)
  FROM unnest(ARRAY[0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15]) WITH ORDINALITY AS "bytes"("byte_index", "position");
$$;--> statement-breakpoint
ALTER TABLE "page_projects" ALTER COLUMN "preview_hash" SET DEFAULT gateway_page_preview_hash();
