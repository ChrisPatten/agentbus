# Telegram: multiple screenshots sent together are only partly delivered to the agent

Reported by: Chris Patten, 2026-09-30 ~13:40-13:50 ET. Status: OPEN (not yet investigated).

## Symptom
- Chris sent 10 screenshots to Peggy in the Telegram group topic (`telegram:peggy:group:<chat-id>`, topic `thread:4f3ece677f7eeb00`). Asked at 13:40 "did you get them all?" - the agent saw a text-only message (`[Replying to Chris: ""]`) with no attachments.
- At 13:49 he sent three more "for snapshot update". The inbound turn contained only TWO `[Image: ...]` entries. The third was not delivered to the agent.
- The third file WAS downloaded: `~/.agentbus_data/media/peggy/abef9b58-8cd6-4661-878f-774cfb2c5819.jpg` (the sample image was removed from the repo because it showed sensitive account details). So the failure is between media download and the prompt/message assembly, not the Telegram fetch.

## Observations
- One inbound message (`6d9d9170-...`) had an image but a blank body; another (`5c59385f-...`) had text plus one image. Looks like a Telegram media group (album) being split into per-photo updates, with one being lost, merged, or coalesced away (possibly debounce/dedup on identical empty `Replying to` text or on timestamp).
- Both messages carry `[Replying to Chris: ""]` with an empty quote - suspicious in itself; nothing was being replied to.
- The first 10-screenshot batch: no attachments reached the agent at all; no error was surfaced to Chris.

## Expected
Every photo in an album arrives as an attachment to the agent (or a visible error/count mismatch is reported to the user).

## Suggested checks
1. Telegram adapter handling of `media_group_id`: per-photo vs. album aggregation, and any dedupe keyed on text/timestamp.
2. Inbound coalescing in the cc-pool adapter: are attachment lists truncated when several messages merge into one turn?
3. Compare `~/.agentbus_data/media/peggy/` file arrival times for 13:38-13:50 against the delivered `[Image:]` entries to find which ones were dropped.
4. Surface a warning to the user when downloaded media is not delivered.

## Impact
Silent data loss: the user believes the agent saw everything. Peggy only noticed because Chris remembered the count.

## Second occurrence (13:52 ET)
Chris sent three screenshots . The turn listed two `[Image:]` paths (251c7089..., d7c0680d...). The third screenshot (`ec4751d8-8ea1-4238-be3e-06449ce9b586.jpg`) was downloaded to the media dir (newest file) but not listed. Pattern: in a 3-photo album, the last (or one) photo is consistently dropped from the delivered message; the other arrives with empty body.
