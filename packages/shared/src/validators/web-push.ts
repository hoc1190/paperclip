import { z } from "zod";

const base64Url = (min: number, max: number) =>
  z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$/, "Must be a base64url string");

export const webPushSubscribeSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .url()
    .refine((value) => value.startsWith("https://"), "Endpoint must be an https URL"),
  keys: z.object({
    p256dh: base64Url(80, 128),
    auth: base64Url(16, 48),
  }),
  userAgent: z.string().max(300).optional(),
});
export type WebPushSubscribe = z.infer<typeof webPushSubscribeSchema>;

export const webPushUnsubscribeSchema = z.object({
  endpoint: z.string().max(2048).url(),
});
export type WebPushUnsubscribe = z.infer<typeof webPushUnsubscribeSchema>;
