-- Migration 022 — per-job model on scheduled_items (E53 S53.3)
--
-- A model fixed on the schedule itself, so a job's model shows up in
-- schedule listings and is created/deleted with the job. NULL means the
-- job has no model of its own; the scheduler falls back to the pool's or
-- an override's model at fire time.

ALTER TABLE scheduled_items ADD COLUMN model TEXT;
