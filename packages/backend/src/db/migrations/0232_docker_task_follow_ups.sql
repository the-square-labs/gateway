-- What an update or recreate still owes once it is settled with the node (the stored env reconciliation after an image
-- change, the stored env restore after a failed asynchronous update) is kept with its task, so it still runs when
-- Gateway lost track of the task: it restarted, or the node's control stream dropped. The env values it needs are
-- sealed with the key and envelope of stored container env; the column is cleared once the follow-ups ran or the task
-- ended. Existing rows keep NULL, and a release before this one does not read the column.
ALTER TABLE "docker_tasks" ADD COLUMN "follow_ups" jsonb;
