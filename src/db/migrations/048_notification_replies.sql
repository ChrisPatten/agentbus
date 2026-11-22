-- E105: replies to notifications. `reply` is the JSON reply config ({mode, prompt, context, hints, on_expire}),
-- NULL for a notification without one. `reply_via` is voice | choice | skip; `replied_at` is when the bus accepted it.
-- `resolution` is the closing text the job sets with update_notification. The binding (where replies go) lives in the
-- existing `conversation_ref` column as JSON.
ALTER TABLE notifications ADD COLUMN reply TEXT;
ALTER TABLE notifications ADD COLUMN replied_at TEXT;
ALTER TABLE notifications ADD COLUMN reply_via TEXT;
ALTER TABLE notifications ADD COLUMN resolution TEXT;
