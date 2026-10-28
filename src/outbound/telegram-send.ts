/**
 * E81 — the `metadata.telegram_send` envelope extension.
 *
 * The send_location / send_venue / send_contact / send_document / send_rich /
 * ask_input tools enqueue an ordinary text envelope whose body is the
 * plain-text fallback (what every non-Telegram channel delivers) and carry
 * the Telegram-native form here. The Telegram adapter validates it again
 * (anything can POST an envelope) and falls back to the body when it is
 * absent or invalid.
 */
import { z } from 'zod';

export const MAX_CAPTION_LENGTH = 1024;

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

export const locationSchema = z.object({ kind: z.literal('location'), latitude, longitude });
export const venueSchema = z.object({
  kind: z.literal('venue'),
  latitude,
  longitude,
  title: z.string().min(1).max(255),
  address: z.string().min(1).max(255),
});
export const contactSchema = z.object({
  kind: z.literal('contact'),
  phone_number: z.string().min(3).max(64),
  first_name: z.string().min(1).max(64),
  last_name: z.string().max(64).optional(),
  vcard: z.string().max(2048).optional(),
});
export const documentSchema = z.object({
  kind: z.enum(['document', 'photo']),
  path: z.string().min(1),
  caption: z.string().max(MAX_CAPTION_LENGTH).optional(),
});
export const richSchema = z.object({
  kind: z.literal('rich'),
  format: z.enum(['markdown', 'html']),
  content: z.string().min(1),
});
export const askInputSchema = z.object({
  kind: z.literal('ask_input'),
  input: z.enum(['location', 'contact', 'person', 'text']),
  placeholder: z.string().max(64).optional(),
});

export const telegramSendSchema = z.discriminatedUnion('kind', [
  locationSchema,
  venueSchema,
  contactSchema,
  documentSchema.extend({ kind: z.literal('document') }),
  documentSchema.extend({ kind: z.literal('photo') }),
  richSchema,
  askInputSchema,
]);

export type TelegramSend = z.infer<typeof telegramSendSchema>;

/** Parses `metadata.telegram_send`; `undefined` when absent, `null` when present but invalid. */
export function parseTelegramSend(raw: unknown): TelegramSend | null | undefined {
  if (raw === undefined) return undefined;
  const parsed = telegramSendSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Apple Maps link for a coordinate pair, used in plain-text fallbacks. */
export function mapsLink(lat: number, lon: number, label?: string): string {
  const q = label ? `&q=${encodeURIComponent(label)}` : '';
  return `https://maps.apple.com/?ll=${lat},${lon}${q}`;
}

export function locationFallback(lat: number, lon: number): string {
  return `Location: ${lat}, ${lon}\n${mapsLink(lat, lon)}`;
}

export function venueFallback(v: { latitude: number; longitude: number; title: string; address: string }): string {
  return `${v.title}\n${v.address}\n${mapsLink(v.latitude, v.longitude, v.title)}`;
}

export function contactFallback(c: { phone_number: string; first_name: string; last_name?: string | undefined }): string {
  return `Contact: ${[c.first_name, c.last_name].filter(Boolean).join(' ')}, ${c.phone_number}`;
}
