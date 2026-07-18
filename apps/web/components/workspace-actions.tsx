"use client";

import { useRouter } from "next/navigation";
import { PlayIcon, RotateCwIcon, SquareIcon, TerminalIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/aurora/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/aurora/tooltip";
import { ToolbarGroup } from "@/components/ui/aurora/toolbar";
import { useToast } from "@/components/ui/aurora/toast";
import {
  dispatchWorkspaceLifecycle,
  lifecycleActionLabel,
  lifecycleActionsFor,
  type WorkspaceLifecycleAction,
} from "@/lib/workspaces/mutations";
import type { Workspace } from "@/lib/workspaces/types";

type WorkspaceAction = WorkspaceLifecycleAction;

export function WorkspaceActions({ workspace }: { workspace: Workspace }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pendingAction, setPendingAction] = React.useState<WorkspaceAction>();
  const [isPending, startTransition] = React.useTransition();

  async function runAction(action: WorkspaceAction) {
    setPendingAction(action);
    try {
      const result = await dispatchWorkspaceLifecycle(workspace.id, action);
      if (!result.started) return;
      toast({
        status: "success",
        title: `${lifecycleActionLabel(action)} dispatched`,
        description: workspace.name,
      });
      startTransition(() => {
        router.refresh();
      });
    } catch (actionError) {
      toast({
        status: "error",
        title: `${lifecycleActionLabel(action)} failed`,
        description:
          actionError instanceof Error
            ? actionError.message
            : "workspace action failed",
      });
    } finally {
      setPendingAction(undefined);
    }
  }

  const busy = isPending || pendingAction !== undefined;
  const controls = lifecycleActionsFor(workspace.state);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <ToolbarGroup>
          {controls.map((action) => (
            <Tooltip key={action}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant={action === "stop" ? "warn" : "aurora"}
                  aria-label={lifecycleActionLabel(action)}
                  loading={pendingAction === action}
                  disabled={busy}
                  onClick={() => void runAction(action)}
                >
                  {iconForAction(action)}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{lifecycleActionLabel(action)}</TooltipContent>
            </Tooltip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup>
          {workspace.terminalUrl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  size="icon"
                  variant="aurora"
                  aria-label="Open terminal"
                >
                  <a href={workspace.terminalUrl}>
                    <TerminalIcon aria-hidden="true" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open terminal</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="neutral"
                  disabled
                  aria-label="Terminal pending"
                >
                  <TerminalIcon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Terminal pending</TooltipContent>
            </Tooltip>
          )}
        </ToolbarGroup>
      </div>
    </div>
  );
}

function iconForAction(action: WorkspaceAction) {
  switch (action) {
    case "start":
      return <PlayIcon aria-hidden="true" />;
    case "stop":
      return <SquareIcon aria-hidden="true" />;
    case "restart":
      return <RotateCwIcon aria-hidden="true" />;
  }
}
