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
  created_at: string;
  created_by: string;
  last_fired_at: string | null;
  fire_count: number;
  max_fires: number | null;
  status: 'active' | 'paused' | 'cancelled' | 'completed';
}
