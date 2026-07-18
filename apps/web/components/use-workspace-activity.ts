"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiErrorMessage } from "@/lib/api-error-message";

export type WorkspaceActivityEntry = {
  at: string;
  action: string;
  actorEmail: string;
  status: string;
};

const DEFAULT_REFRESH_INTERVAL_MS = 15_000;

export function useWorkspaceActivity(
  workspaceId: string,
  limit: number,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
) {
  const [entries, setEntries] = useState<WorkspaceActivityEntry[]>([]);
  const [error, setError] = useState<string>();
  const requestRef = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/activity`, {
        headers: { "Cache-Control": "no-store" },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(apiErrorMessage(body, "failed to load activity"));
      }
      setEntries(Array.isArray(body.activity) ? body.activity.slice(0, limit) : []);
      setError(undefined);
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setError(
          loadError instanceof Error ? loadError.message : "failed to load activity",
        );
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = undefined;
    }
  }, [limit, workspaceId]);

  useEffect(() => {
    let timer: number | undefined;
    const start = () => {
      if (timer !== undefined || document.hidden) return;
      void refresh();
      timer = window.setInterval(() => void refresh(), refreshIntervalMs);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      requestRef.current?.abort();
      requestRef.current = undefined;
    };
    const handleVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    start();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stop();
    };
  }, [refresh, refreshIntervalMs]);

  return { entries, error, refresh };
}
