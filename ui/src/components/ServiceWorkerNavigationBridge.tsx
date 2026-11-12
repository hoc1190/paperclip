import { useEffect } from "react";
import { useNavigate } from "@/lib/router";

/** Navigates in place when the service worker asks an open window to open a pushed Inbox item. */
export function ServiceWorkerNavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== "paperclip:navigate") return;
      const url = data.url;
      if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return;
      navigate(url);
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [navigate]);
  return null;
}
