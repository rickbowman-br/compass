"use client";

import { useState, useTransition } from "react";
import { updateDeveloperSandboxEnabled } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialEnabled: boolean;
  canEdit: boolean;
}

/**
 * Workspace-admin switch for the developer sandbox class. Turning it on lets shared agents be set to the developer
 * sandbox (Postgres, pnpm, a build toolchain); it does not change any agent by itself.
 */
export function AgentDeveloperSandboxPanel({ orgSlug, workspaceSlug, initialEnabled, canEdit }: Props) {
  const [saved, setSaved] = useState(initialEnabled);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await updateDeveloperSandboxEnabled(orgSlug, workspaceSlug, enabled);
        setSaved(result.enabled);
        setEnabled(result.enabled);
        setNotice(result.enabled ? "Saved. Shared agents in this workspace can now use the developer sandbox." : "Saved. Agents set to the developer sandbox will be refused until it is turned back on.");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save");
      }
    });
  }

  if (!canEdit) {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-3.5 text-xs text-muted-foreground" data-testid="agent-developer-sandbox-readonly">
        {saved ? "The developer sandbox is enabled for this workspace." : "The developer sandbox is not enabled. Ask a workspace admin to turn it on."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
      <label className="flex items-start gap-2 text-sm" htmlFor="agent-developer-sandbox-enabled">
        <Checkbox id="agent-developer-sandbox-enabled" data-testid="agent-developer-sandbox-input" className="mt-0.5" checked={enabled} disabled={isPending} onCheckedChange={(checked) => setEnabled(checked)} />
        <span>
          <span className="font-medium">Allow the developer sandbox</span>{" "}
          <span className="text-xs text-muted-foreground">— a larger sandbox with a local PostgreSQL, pnpm and build tools, for agents that build and test projects. It costs more per run than the standard sandbox.</span>
        </span>
      </label>
      {notice && <p role="status" data-testid="agent-developer-sandbox-notice" className="text-xs text-status-success">{notice}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div>
        <Button size="sm" onClick={handleSave} disabled={isPending || enabled === saved} data-testid="agent-developer-sandbox-save">
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
