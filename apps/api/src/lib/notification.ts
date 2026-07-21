import { CashRequestRecord } from './store.js';

export interface SentNotification {
  recipient: string;
  type: 'email' | 'sms';
  subject?: string;
  message: string;
  timestamp: string;
}

export const sentNotificationsQueue: SentNotification[] = [];

export function clearNotificationQueue() {
  sentNotificationsQueue.length = 0;
}

export async function sendNotification(
  record: CashRequestRecord,
  newStatus: 'released' | 'refunded'
): Promise<void> {
  const { notificationType, contactInfo, id, amountStroops } = record;
  if (!notificationType || notificationType === 'none' || !contactInfo) {
    return;
  }

  // Formatting amount
  const n = BigInt(amountStroops);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, '0').slice(0, 2);
  const formattedAmount = `${whole}.${frac}`;

  const message = `Velo claim update: Your claim ${id} for ${formattedAmount} XLM/USDC has been ${newStatus}.`;

  const notification: SentNotification = {
    recipient: contactInfo,
    type: notificationType,
    message,
    timestamp: new Date().toISOString(),
  };

  if (notificationType === 'email') {
    notification.subject = `Velo Claim Update: ${newStatus.toUpperCase()}`;
  }

  sentNotificationsQueue.push(notification);

  // In a production app, we would integrate Twilio / SendGrid here.
  // For development and testing, we log to stdout.
  console.log(`[Notification System] Sent ${notificationType} to ${contactInfo}:`);
  console.log(`  Subject: ${notification.subject ?? 'N/A'}`);
  console.log(`  Message: ${message}`);
}
