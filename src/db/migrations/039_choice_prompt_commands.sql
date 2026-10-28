-- Migration 039 — choice_prompts.commands (E54 S54.2, extends E74)
--
-- Optional per-choice command payloads. A JSON array parallel to `labels`
-- whose entries are either a slash-command string (e.g. "/model claude-opus-5-5")
-- or null. When a tapped choice has a command, the Telegram tap handler injects
-- that command as the user's inbound message instead of "[tapped] <label>".
-- NULL (the default) = a plain E74 prompt; behaviour unchanged.

ALTER TABLE choice_prompts ADD COLUMN commands TEXT;
