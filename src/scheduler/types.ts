/** A row from the scheduled_items table. */
export interface ScheduledItem {
  id: string;
  type: 'once' | 'cron';
  cron_expr: string | null;
  timezone: string;
  fire_at: string;         // ISO UTC
  channel: string;
  sender: string;
  payload_body: string;
  topic: string;
  priority: 'normal' | 'high' | 'urgent';
  label: string | null;
  /** Model this job's pane should launch with, e.g. "haiku". NULL = no job-level model (E53). */
  model: string | null;
  created_at: string;
  created_by: string;
  last_fired_at: string | null;
  fire_count: number;
  max_fires: number | null;
  /** Only meaningful for type='once'. Null = no staleness limit (fire no matter how overdue). */
  stale_after_ms: number | null;
  status: 'active' | 'paused' | 'cancelled' | 'completed' | 'dead_letter';
}
