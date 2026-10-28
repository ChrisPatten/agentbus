-- Migration 041 — choice_prompts.buttons (E81 / S81.3)
--
-- Buttons v2: a `choices` item may be an object `{label, style?, copy_text?, url?}`
-- instead of a plain string. A JSON array parallel to `labels` holding each
-- button's non-label attributes ({"style":..,"copy_text":..,"url":..}); NULL
-- (the default) = every button is a plain E74 callback button, and the tap
-- handler keeps the E74 "You chose: <label>" behavior. When set, a tap edits
-- the keyboard to the chosen button, disabled, instead of dropping it.

ALTER TABLE choice_prompts ADD COLUMN buttons TEXT;
