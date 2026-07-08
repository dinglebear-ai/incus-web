import { headers } from "next/headers";

import { AgentRunSessionPage } from "@/components/agent-run-session-page";
import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import { getWorkspaceRefForActor } from "@/lib/workspaces/provisioner";

type PageProps = {
  params: Promise<{
    workspaceId: string;
    runId: string;
  }>;
};

export default async function AgentRunPage({ params }: PageProps) {
  const { workspaceId, runId } = await params;
  let pageError: { title: string; message: string } | undefined;
  try {
    const actor = getActorFromHeaders(await headers());
    const access = getWorkspaceRefForActor(actor);
    if (!access.ok || access.workspace.id !== workspaceId) {
      pageError = {
        title: "Session unavailable",
        message: "Workspace was not found.",
      };
    }
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      pageError = {
        title: "Authentication required",
        message:
          "incus-web did not receive trusted identity headers from the authentication proxy.",
      };
    } else {
      throw error;
    }
  }

  if (pageError) return <PageError {...pageError} />;

  return <AgentRunSessionPage workspaceId={workspaceId} runId={runId} />;
}

function PageError({ title, message }: { title: string; message: string }) {
  return (
    <main className="min-h-screen bg-[var(--aurora-page-bg)] px-6 py-10 text-[var(--aurora-text-primary)]">
      <div className="mx-auto max-w-3xl rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] p-6">
        <p className="aurora-text-eyebrow text-[var(--aurora-accent-primary)]">
          {title}
        </p>
        <h1 className="aurora-text-section mt-3">Agent run viewer</h1>
        <p className="aurora-text-body mt-3 text-[var(--aurora-text-muted)]">
          {message}
        </p>
      </div>
    </main>
  );
}
