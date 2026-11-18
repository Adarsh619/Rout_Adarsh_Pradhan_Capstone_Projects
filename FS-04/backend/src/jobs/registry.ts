import { deliverWebhook, deleteOldWebhookDeliveries, generateAllWeeklyReports, generateWeeklyReport, sendDueDateReminders, sendNotificationEmails } from "../modules/integrations/jobs.js";
import { purgeVisitorData, resetDemoData } from "../modules/demo/jobs.js";
import type { JobName } from "./queue.js";

// Job name → handler. Jobs carry only ids; handlers re-read PostgreSQL, so a job that runs twice is harmless.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlers: Record<JobName, (data: any) => Promise<unknown>> = {
  deliver_webhook: deliverWebhook,
  send_notification_emails: sendNotificationEmails,
  generate_weekly_report: generateWeeklyReport,
  generate_all_weekly_reports: generateAllWeeklyReports,
  send_due_date_reminders: sendDueDateReminders,
  delete_old_webhook_deliveries: deleteOldWebhookDeliveries,
  reset_demo_data: resetDemoData,
  purge_visitor_data: purgeVisitorData,
};

export function runJob(name: string, data: Record<string, unknown>): Promise<unknown> {
  const handler = handlers[name as JobName];
  if (!handler) throw new Error(`Unknown job ${name}`);
  return handler(data);
}

// The schedule, in UTC (BullMQ job schedulers; the v1 Celery beat schedule).
export const SCHEDULE: Array<{ name: JobName; pattern: string }> = [
  { name: "generate_all_weekly_reports", pattern: "0 6 * * 1" }, // Mondays 06:00
  { name: "send_due_date_reminders", pattern: "0 7 * * *" }, // daily 07:00
  { name: "delete_old_webhook_deliveries", pattern: "30 3 * * *" }, // daily 03:30
  // Only acts when DEMO_MODE is on: 21:00 UTC is 02:30 in India, when the demo is least likely to be in use.
  { name: "reset_demo_data", pattern: "0 21 * * *" },
];
