/**
 * E53 S53.3 / D1 — default topic for a schedule created without an explicit one.
 *
 * A pool pane's model is fixed for the life of its Claude session, and all
 * conversations on the same (contact, channel, topic) share one session. A
 * recurring schedule that fell into the same "general" topic as everything
 * else on its channel would therefore share a pane — and a model — with
 * whatever else uses that topic. Giving each recurring schedule its own
 * topic (`sched:<slug>`) gives it its own conversation, and so its own pane
 * and its own model.
 *
 * One-shot reminders don't get this treatment: they fire once and are done,
 * so there's no ongoing session identity worth isolating.
 */

/** lowercase, non-alphanumerics -> '-', collapse repeats, trim leading/trailing '-'. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Compute the default topic for a new schedule when none was given explicitly.
 *
 * - `once` schedules always default to `general`.
 * - `cron` schedules default to `sched:<label-slug>`, or `sched:<id8>` when
 *   there's no usable label (missing, or slugifies to nothing).
 */
export function defaultScheduleTopic(
  type: 'once' | 'cron',
  label: string | null | undefined,
  id: string,
): string {
  if (type === 'once') return 'general';
  const slug = label ? slugify(label) : '';
  return slug ? `sched:${slug}` : `sched:${id.slice(0, 8)}`;
}
