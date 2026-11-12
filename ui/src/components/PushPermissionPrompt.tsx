import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, LoaderCircle } from "lucide-react";
import { webPushApi } from "@/api/webPush";
import { describeError } from "@/api/errors";
import { useToastActions } from "@/context/ToastContext";
import { useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { readSnoozedUntil, shouldShowPushPrompt, snoozePushPrompt } from "@/lib/push-permission-prompt";
import { enablePush, getCurrentEndpoint, getPushSupport, isStandalone } from "@/lib/web-push";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SHOW_DELAY_MS = 2000;
const promptEndpointKey = ["web-push", "prompt-endpoint"] as const;

function describeFailure(error: unknown): { denied: boolean; message: string } {
  if (error instanceof Error && error.message === "PERMISSION_DENIED") {
    return {
      denied: true,
      message:
        "Thông báo đang bị chặn. Để cho phép, mở Cài đặt > Thông báo > Paperclip (trên iPhone/iPad) rồi bật Cho phép thông báo.",
    };
  }
  if (error instanceof Error && error.message === "PERMISSION_DISMISSED") {
    return { denied: false, message: "Chưa cấp quyền thông báo. Hãy thử lại." };
  }
  return { denied: false, message: describeError(error, { action: "enable notifications" }).body };
}

/**
 * Asks installed-PWA users to enable Inbox push. iOS only shows the system
 * permission dialog from a user tap, so this dialog's button raises it.
 */
export function PushPermissionPrompt() {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { pathname } = useLocation();
  const [delayElapsed, setDelayElapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ denied: boolean; message: string } | null>(null);

  const standalone = isStandalone();
  const support = getPushSupport();
  const permission = typeof Notification === "undefined" ? undefined : Notification.permission;
  const preChecks = standalone && support === "available" && permission === "default";

  const configQuery = useQuery({
    queryKey: queryKeys.webPush.config,
    queryFn: () => webPushApi.getConfig(),
    enabled: preChecks,
  });
  const endpointQuery = useQuery({
    queryKey: promptEndpointKey,
    queryFn: () => getCurrentEndpoint(),
    enabled: preChecks,
  });
  const config = configQuery.data;

  const eligible = shouldShowPushPrompt({
    standalone,
    support,
    permission,
    config,
    hasSubscription: endpointQuery.isSuccess ? endpointQuery.data !== null : undefined,
    snoozedUntil: readSnoozedUntil(),
    now: Date.now(),
    pathname,
  });

  useEffect(() => {
    if (!eligible || open) return;
    const timer = window.setTimeout(() => setDelayElapsed(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [eligible, open]);

  // Latch open: once shown, stay until closed even though permission changes mid-flow.
  useEffect(() => {
    if (eligible && delayElapsed) setOpen(true);
  }, [eligible, delayElapsed]);

  function handleEnable() {
    if (!config) return;
    const pending = enablePush(config);
    setBusy(true);
    setFailure(null);
    pending
      .then(() => {
        setOpen(false);
        pushToast({ title: "Đã bật thông báo Inbox", tone: "success" });
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.webPush.mine }),
          queryClient.invalidateQueries({ queryKey: queryKeys.webPush.config }),
          queryClient.invalidateQueries({ queryKey: promptEndpointKey }),
          queryClient.invalidateQueries({ queryKey: ["web-push", "current-endpoint"] }),
        ]);
      })
      .catch((error) => setFailure(describeFailure(error)))
      .finally(() => setBusy(false));
  }

  function handleLater() {
    snoozePushPrompt();
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : handleLater())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="size-5" />
            Bật thông báo Inbox
          </DialogTitle>
          <DialogDescription>
            Paperclip sẽ báo trên điện thoại khi có mục mới cần bạn xử lý, kèm tiêu đề đầy đủ của mục đó. Chạm vào
            thông báo để mở thẳng mục đó.
          </DialogDescription>
        </DialogHeader>
        {failure ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {failure.message}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={handleLater}>
            Để sau
          </Button>
          {failure?.denied ? null : (
            <Button type="button" disabled={busy || !config} onClick={handleEnable}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {failure ? "Thử lại" : "Bật thông báo"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
