import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, LoaderCircle } from "lucide-react";
import { webPushApi } from "@/api/webPush";
import { describeError } from "@/api/errors";
import { queryKeys } from "@/lib/queryKeys";
import { disablePush, enablePush, getCurrentEndpoint, getPushSupport } from "@/lib/web-push";
import { Button } from "@/components/ui/button";

const currentEndpointKey = ["web-push", "current-endpoint"] as const;

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message === "PERMISSION_DENIED") {
    return "Notifications were blocked. Allow them in your device settings, then try again.";
  }
  if (error instanceof Error && error.message === "PERMISSION_DISMISSED") {
    return "Notification permission was not granted. Tap the button to try again.";
  }
  return describeError(error, { action: "update notifications" }).body;
}

function Message({ children, role }: { children: React.ReactNode; role?: "alert" | "status" }) {
  return (
    <p role={role} className="max-w-2xl text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * "Notify me on this device" control for Inbox Web Push. The toggle lives only in
 * Profile settings; the permission prompt is raised from the button tap.
 */
export function PushNotificationsControl() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"enabling" | "disabling" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const support = getPushSupport();
  const canUsePush = support === "available";

  const configQuery = useQuery({
    queryKey: queryKeys.webPush.config,
    queryFn: () => webPushApi.getConfig(),
  });
  const endpointQuery = useQuery({
    queryKey: currentEndpointKey,
    queryFn: () => getCurrentEndpoint(),
    enabled: canUsePush,
  });
  const devicesQuery = useQuery({
    queryKey: queryKeys.webPush.mine,
    queryFn: () => webPushApi.listMine(),
    enabled: canUsePush && !!endpointQuery.data,
  });

  const config = configQuery.data;
  const isOn = canUsePush && Notification.permission === "granted" && !!endpointQuery.data;

  // Tap handler: enablePush's first statement is Notification.requestPermission(),
  // and nothing is awaited before calling it, so iOS keeps it inside the gesture.
  function handleEnable() {
    if (!config) return;
    setActionError(null);
    setBusy("enabling");
    enablePush(config)
      .then(() =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: currentEndpointKey }),
          queryClient.invalidateQueries({ queryKey: queryKeys.webPush.mine }),
        ]),
      )
      .catch((error) => setActionError(describeFailure(error)))
      .finally(() => setBusy(null));
  }

  async function handleDisable() {
    setActionError(null);
    setBusy("disabling");
    try {
      await disablePush();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: currentEndpointKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.webPush.mine }),
      ]);
    } catch (error) {
      setActionError(describeFailure(error));
    } finally {
      setBusy(null);
    }
  }

  let body: React.ReactNode;
  if (support === "ios-needs-install") {
    body = (
      <Message>
        To get notifications on iPhone or iPad, add Paperclip to your Home Screen (Share, then Add to Home
        Screen), then open it from there and come back to this page.
      </Message>
    );
  } else if (support === "unsupported") {
    body = <Message>This browser does not support push notifications.</Message>;
  } else if (configQuery.isPending) {
    body = <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />;
  } else if (configQuery.isError) {
    body = (
      <div className="space-y-2">
        <div role="alert" className="max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {describeError(configQuery.error, { action: "load notification settings" }).body}
        </div>
        <Button type="button" variant="outline" onClick={() => void configQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (!config?.enabled) {
    body = (
      <Message>
        Push notifications are turned off on this server. Ask an administrator to enable them.
      </Message>
    );
  } else if (support === "denied") {
    body = (
      <Message>
        Notifications are blocked for Paperclip. To allow them, open your browser or device settings, find
        Paperclip under notifications, allow them, then reload this page.
      </Message>
    );
  } else if (isOn) {
    const devices = devicesQuery.data ?? [];
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium" role="status">On for this device</span>
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void handleDisable()}>
            {busy === "disabling" ? <LoaderCircle className="size-4 animate-spin" /> : <BellOff className="size-4" />}
            Turn off
          </Button>
        </div>
        {devices.length > 0 ? (
          <div className="max-w-2xl space-y-1">
            <div className="text-xs text-muted-foreground">Devices receiving notifications</div>
            <ul className="space-y-1 text-sm">
              {devices.map((device) => (
                <li key={device.id} className="truncate">{device.userAgent ?? "Unknown device"}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  } else {
    body = (
      <Button type="button" disabled={busy !== null} onClick={handleEnable}>
        {busy === "enabling" ? <LoaderCircle className="size-4 animate-spin" /> : <Bell className="size-4" />}
        {busy === "enabling" ? "Turning on…" : "Turn on notifications on this device"}
      </Button>
    );
  }

  return (
    <section className="space-y-4" aria-label="Inbox notifications">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Inbox notifications</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Get a push notification on this device when a new item needs you. Tapping it opens the item.
        </p>
      </div>
      {body}
      {actionError ? (
        <div className="space-y-2">
          <div role="alert" className="max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {actionError}
          </div>
          {!isOn && canUsePush && config?.enabled ? (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={handleEnable}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
