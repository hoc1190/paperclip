# Web Push for Inbox items

Paperclip can send a Web Push notification to your phone or desktop when a new
item lands in the board Inbox (the `/{prefix}/decisions` "What needs me" feed).
It is a separate channel that runs next to the Slack Inbox notifier and reads
the same pending-items feed. Slack behavior is unchanged.

## What you get

- One push per new Inbox item, sent to every device where notifications are on.
- The notification title is the item's full title. The body is the ask, the
  related issue and the agent, joined with ` · `. The ask lines are the same
  strings the Slack notifier uses (currently Vietnamese).
- `recovery_action` items are never pushed (same rule as Slack).
- Tapping the notification opens `/{prefix}/decisions?item=<id>`. If the app is
  already open it is focused and navigated in place; otherwise it is opened.
- Every push shows a visible notification. If the payload cannot be parsed the
  service worker shows "Paperclip / New Inbox item" instead, because iOS
  revokes subscriptions that receive pushes showing nothing.

## Turn it on

Notifications are enabled per device from the profile settings page
(`company/settings/instance/profile`, "Inbox notifications"). The browser
permission prompt is raised from the button tap.

- **iPhone / iPad (iOS 16.4 or later):** Web Push only works from the
  installed app. In Safari use Share, then Add to Home Screen. Open Paperclip
  from the Home Screen icon, go to Profile settings and tap "Turn on
  notifications on this device". In a Safari tab the control only shows the
  install instructions.
- **Android (Chrome):** open Paperclip in Chrome (installed or not), go to
  Profile settings and tap the button, then allow notifications.
- **Desktop browsers with push support** work the same way.

If notifications were blocked, the control explains how to re-allow them in
the browser or device settings. If the server has push disabled, the control
says so.

## Configuration

| Variable | Effect |
| --- | --- |
| `PAPERCLIP_WEB_PUSH=false` | Disables Web Push. The notifier is not started and `GET /api/web-push/config` reports `enabled: false`. Any other value (or unset) leaves it on. |
| `PAPERCLIP_WEB_PUSH_SUBJECT` | VAPID subject. Must be an `https://` URL or a `mailto:` address, otherwise push is disabled with a warning (Apple rejects a missing or malformed subject). Defaults to `https://paperclip.vibehonban.jp`. |
| `PAPERCLIP_WEB_PUSH_VAPID_PUBLIC_KEY` and `PAPERCLIP_WEB_PUSH_VAPID_PRIVATE_KEY` | Override the VAPID key pair. Both must be set; if only one is set, the derived key is used. |

Without the override, the VAPID key pair is derived deterministically from the
instance master key (the `local_encrypted` secrets key, see "Secrets in Dev" in
`doc/DEVELOPING.md`) using a purpose-specific HKDF secret
(`web-push-vapid:v1`). Nothing new is stored, and nothing new needs backing up
beyond the master key. If the master key cannot be loaded, push is disabled
with a warning (and re-checked after 30 seconds) instead of failing startup.

Push is also off on a warm standby server.

Each subscription records the key id (a short SHA-256 of the public key) it
was made with. If the key changes (master key rotated or lost, or the env
override changed), rows with the old key id are deleted when the server next
sends, and a device that opens the app with permission still granted
re-subscribes on startup.

## How it works

Server pieces:

- `server/src/services/inbox-web-push-notifier.ts`: detection and fan-out.
- `server/src/services/web-push-subscriptions.ts`: subscription storage,
  endpoint allowlist, sending, cleanup.
- `server/src/services/web-push-vapid.ts`: key resolution.
- `server/src/routes/web-push.ts`: HTTP API.
- Tables `web_push_subscriptions` and `web_push_inbox_notices`.

Client pieces: `ui/public/sw.js` (`push`, `notificationclick`,
`pushsubscriptionchange` handlers), `ui/src/lib/web-push.ts`,
`ui/src/components/PushNotificationsControl.tsx`.

### Trigger (no polling)

The notifier is event driven. It listens to company live events of type
`activity.logged`, `heartbeat.run.status` and `agent.status`. A matching event
marks that company dirty and schedules a flush 3 seconds later, so a burst of
events becomes one run. It registers with the delivery-work coordinator with no
recurring poll (`hasPending` is always false; the only deadline is the pending
flush).

With no subscriptions at all, events are ignored before any SQL runs and no
timers are armed. On startup, if any subscription exists, every company of the
subscribed users is checked once, which catches items created while the server
was down. A failed run for a company is retried after 5 seconds, up to 5 times.

Items that appear only because time passed (for example a snooze expiring)
produce no live event, so they are pushed on the next event in that company.

### Baseline and dedup

Each push is recorded in `web_push_inbox_notices` before it is sent, so a crash
or restart never sends the same item twice. A failed send is not retried.

- **First enable:** the first run for a user and company writes a
  `__baseline__` marker and records everything currently pending without
  sending. Only items that appear later are pushed. Registering a subscription
  triggers this immediately.
- **Last device removed:** when a user's last subscription is deleted (turned
  off, expired, or cleaned up), their notice rows including the baseline are
  deleted. Turning notifications on again re-baselines, so items that arrived
  while off are not pushed.
- Notice rows for items no longer pending are pruned after 7 days, so an item
  that resolves and returns within a week is not pushed again.

### Burst grouping

When one run finds more than 5 new items, the 5 oldest are pushed individually
(oldest activity first). The rest are marked notified and replaced by a single
summary push, "+N mục mới trong Inbox", that opens `/{prefix}/decisions`.

### Payload

JSON with `v: 1`, `title`, `body`, `url`, `tag` (the item id), `companyId`,
`itemId`, and `renotify` for the summary. The title is sent in full. Only if
the serialized payload exceeds 3000 bytes is the body shortened first and then
the title. Messages are encrypted by the `web-push` library, sent with a TTL of
24 hours and high urgency.

## Endpoint allowlist

A subscription endpoint is accepted only if it is an `https` URL on a known push
service host:

- `fcm.googleapis.com`
- `web.push.apple.com`
- `updates.push.services.mozilla.com`
- `*.push.services.mozilla.com`
- `*.notify.windows.com`

The check runs when subscribing and again before every send. The reason: in
`local_trusted` mode any process that can reach the server is the board user,
including local agents. Without an allowlist such a process could register its
own endpoint to read Inbox titles, or turn the server into an outbound request
client. A disallowed endpoint is rejected with 422 on subscribe and removed if
found at send time. A subscription endpoint already registered by another user
is rejected with 409.

## Subscription cleanup

- 404 or 410 from the push service: the subscription is deleted.
- 400, 401, 403 or 413: it is deleted and a warning is logged.
- Other failures (429, 5xx, network, timeouts of 10 seconds per request and 15
  seconds overall): the failure is recorded and the row is kept. It is deleted
  after 10 consecutive failures, or if there has been no success for 7 days
  (counted from creation if it never succeeded).
- Rows signed with a different VAPID key id, or with invalid keys, are deleted.
- A user keeps at most 20 subscriptions; the oldest are evicted.
- On every app start with permission granted, the page re-registers its
  subscription (and re-subscribes if the server key changed), which repairs rows
  removed by the rules above. It never prompts. The service worker also tries
  to re-subscribe on `pushsubscriptionchange`, best effort.

## API

All routes require a board user and return 503 on a warm standby server. They
are under `/api/web-push`.

| Route | Description |
| --- | --- |
| `GET /web-push/config` | `{ enabled, publicKey }`. `enabled` is false when push is disabled or no key is available. |
| `GET /web-push/subscriptions/me` | The caller's subscriptions: `id`, `userAgent`, `createdAt`, `lastSuccessAt`. |
| `PUT /web-push/subscriptions/me` | Body `{ endpoint, keys: { p256dh, auth }, userAgent? }`. Idempotent upsert. 422 for a disallowed host, 409 if another user owns the endpoint, 503 if disabled. Returns the summary. |
| `POST /web-push/subscriptions/me/unsubscribe` | Body `{ endpoint }`. Deletes only the caller's row. Always 204. |

## Cloudflare Access

Push delivery does not pass through Cloudflare Access: the push service talks
to the browser, not to Paperclip. What Access affects is tapping a
notification. If the Access session has expired, the tap lands on the Access
login first, and only then continues to the item. The length of the Access
session therefore decides how often that happens. The service worker's
`pushsubscriptionchange` re-subscribe request also fails silently without a
valid Access cookie; the startup sync repairs that.

## Known limits

- The single local-board user: every device behind the same access gets every
  push. There are no per-device, per-kind or per-company preferences, quiet
  hours, reminders, "resolved" updates or badge counts.
- Notification titles appear on the lock screen. Payloads are encrypted in
  transit, but they pass through Apple, Google or Mozilla push infrastructure.
- The trigger is in-process, so it suits a single server instance.
- Delivery is best effort; a failed send for an item is not retried.
- A push cannot be withdrawn once shown (iOS does not allow silent pushes).
