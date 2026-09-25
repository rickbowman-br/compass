import { redirect } from "next/navigation";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { ManageFieldsPanel } from "@/components/custom-fields/manage-fields-panel";
import { SharedOptionSetsPanel } from "@/components/custom-fields/shared-option-sets-panel";
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions";
import { parseSelectOptions } from "@/lib/shared-field-options";
import { ManageSquadsPanel } from "@/components/squads/manage-squads-panel";
import { ManageMembersPanel } from "@/components/settings/manage-members-panel";
import { ManageApiKeysPanel } from "@/components/settings/manage-api-keys-panel";
import { PortalSettingsPanel } from "@/components/settings/portal-settings-panel";
import { DeliveryLimitsPanel } from "@/components/settings/delivery-limits-panel";
import { LaunchWorkflowSettingsPanel } from "@/components/settings/launch-workflow-settings-panel";
import { WorkspaceBrandingPanel } from "@/components/settings/workspace-branding-panel";
import { DeleteWorkspacePanel } from "@/components/settings/delete-workspace-panel";
import { WorkspaceScoringPanel } from "@/components/scoring-models/workspace-scoring-panel";
import type { ApiKeyRow } from "@/components/settings/manage-api-keys-panel";
import type {
  CustomFieldDefinitionData,
  CustomFieldObjectType,
  SharedFieldOptionSetData,
  SquadData,
  MemberData,
} from "@/lib/types";
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles";
import { PageHeader } from "@/components/patterns/page-header";
import { SettingsSection } from "@/components/patterns/settings-section";
import { CapabilityPacksPanel, type CapabilityPackSettingsRow } from "@/components/settings/capability-packs-panel";
import { ThemePreferenceControl } from "@/components/theme/theme-preference-control";
import { WorkspaceAgentsPanel } from "@/components/settings/workspace-agents-panel";
import { AgentActivity } from "@/components/settings/agent-activity";
import { agentsEnabled } from "@/lib/agent-access";
import { AnalyticsSettingsPanel } from "@/components/analytics/analytics-settings-panel";
import { listConnections, listMetrics } from "@/lib/analytics/service";
import {
  FeedbackSourcesPanel,
  type ArtifactOption,
  type FeedbackSourceRow,
} from "@/components/settings/feedback-sources-panel";
import { optionalCompassUrl, trustedCompassBaseUrl } from "@/lib/compass-url";

export const metadata = { title: "Workspace Settings" };

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
};

export default async function SettingsPage({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } },
    select: {
      id: true,
      organizationId: true,
      organization: { select: { members: { where: { userId: session.user?.id }, select: { role: true } } } },
      name: true,
      feedbackEnabled: true,
      roadmapPublic: true,
      nowLimit: true,
      nextLimit: true,
      portalAuthRequired: true,
      artifactFeedbackPublic: true,
      ssoEnabled: true,
      launchWorkflowEnabled: true,
      ssoSecretEncrypted: true,
      ssoSecretUpdatedAt: true,
      brandingPaletteId: true,
      brandingPrimaryHex: true,
      brandingFontPresetId: true,
      brandingFontFamily: true,
      brandingLogoUrl: true,
    },
  });

  if (!workspace) redirect("/dashboard");

  const [rawFields, rawSharedOptionSets, rawSquads, rawApiKeys, rawMembers, rawScoringModels, scoringConfig, rawCapabilityPacks] = await Promise.all([
    prisma.customFieldDefinition.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ objectType: "asc" }, { order: "asc" }],
      include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
    }),
    prisma.sharedFieldOptionSet.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { name: "asc" },
      include: {
        fields: {
          select: { id: true, name: true, objectType: true },
          orderBy: [{ objectType: "asc" }, { order: "asc" }],
        },
      },
    }),
    prisma.squad.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    }),
    session.user?.id
      ? prisma.apiKey.findMany({
          where: { userId: session.user.id, agentId: null },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.scoringModel.findMany({
      where: { organizationId: workspace.organizationId, status: "ACTIVE" },
      select: { id: true, name: true, formulaType: true },
      orderBy: { name: "asc" },
    }),
    prisma.workspaceScoringConfig.findUnique({
      where: { workspaceId: workspace.id },
      select: { scoringModelId: true },
    }),
    prisma.workspaceCapabilityPack.findMany({
      where: { workspaceId: workspace.id },
      include: { capabilityPackVersion: { include: { capabilityPack: { include: { versions: { orderBy: { createdAt: "desc" } } } } } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const fields: CustomFieldDefinitionData[] = rawFields.map(toCustomFieldDefinitionData);

  const sharedOptionSets: SharedFieldOptionSetData[] = rawSharedOptionSets.map((set) => ({
    id: set.id,
    name: set.name,
    options: parseSelectOptions(set.options),
    fieldCount: set.fields.length,
    usedBy: set.fields.map((field) => ({
      id: field.id,
      name: field.name,
      objectType: field.objectType as CustomFieldObjectType,
    })),
    updatedAt: set.updatedAt.toISOString(),
  }));

  const squads: SquadData[] = rawSquads.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));

  const apiKeys: ApiKeyRow[] = rawApiKeys.map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
  }));

  const members: MemberData[] = rawMembers.map((m) => ({
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    role: normalizeWorkspaceRole(m.role),
  }));

  const currentUserMembershipId =
    rawMembers.find((m) => m.userId === session.user?.id)?.id ?? null;
  const currentWorkspaceRole = rawMembers.find((m) => m.userId === session.user?.id)?.role;
  const canManageCapabilityPacks = normalizeWorkspaceRole(currentWorkspaceRole) === "ADMIN" || isOrgAdminRole(workspace.organization.members[0]?.role);
  const analyticsActor = { userId: session.user.id, purpose: "USER" as const };
  const [analyticsConnections, analyticsMetrics] = await Promise.all([
    listConnections(analyticsActor, workspace.id),
    listMetrics(analyticsActor, workspace.id),
  ]);
  const grants = await prisma.agentWorkspaceGrant.findMany({ where: { workspaceId: workspace.id, revokedAt: null } });
  const workspaceAgents = await prisma.agent.findMany({ where: canManageCapabilityPacks ? { OR: [{ ownerUserId: { in: rawMembers.map((m) => m.userId) } }, { id: { in: grants.map((g) => g.agentId) } }] } : { id: { in: grants.map((g) => g.agentId) } }, orderBy: { name: "asc" } });
  const agentActivity = canManageCapabilityPacks ? await prisma.agentToolCall.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "desc" }, take: 25 }) : [];
  // Embed tokens are a public write credential, so the panel below is gated on
  // the same bar its server actions enforce (resolveWorkspaceAdmin: workspace
  // admin or org admin) — which is exactly what canManageCapabilityPacks is.
  // Skipping the queries for non-admins also keeps two round-trips off the page
  // for the majority of viewers who will never see the section.
  const [rawFeedbackSources, rawFeedbackArtifacts] = canManageCapabilityPacks
    ? await Promise.all([
        prisma.feedbackSource.findMany({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            artifactId: true,
            allowedOrigins: true,
            enabled: true,
            artifact: { select: { title: true } },
            tokens: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                tokenPrefix: true,
                label: true,
                createdAt: true,
                lastUsedAt: true,
                revokedAt: true,
                expiresAt: true,
              },
            },
          },
        }),
        prisma.artifact.findMany({
          where: { workspaceId: workspace.id, status: "ACTIVE" },
          orderBy: { updatedAt: "desc" },
          select: { id: true, title: true },
        }),
      ])
    : [[], []];
  const feedbackSources: FeedbackSourceRow[] = rawFeedbackSources.map((source) => ({
    id: source.id,
    name: source.name,
    artifactId: source.artifactId,
    artifactTitle: source.artifact?.title ?? null,
    // `allowedOrigins` is a Json column; anything that is not an array of strings
    // did not come from normalizeAllowedOrigins and is not something the widget
    // would honor either, so it is dropped rather than rendered.
    allowedOrigins: Array.isArray(source.allowedOrigins)
      ? source.allowedOrigins.filter((entry): entry is string => typeof entry === "string")
      : [],
    enabled: source.enabled,
    tokens: source.tokens,
  }));
  const feedbackArtifacts: ArtifactOption[] = rawFeedbackArtifacts;
  // Resolved here rather than from window.location so the first client render
  // matches the server's, and optional because a deployment without a configured
  // URL should still render the panel — just without a copyable snippet.
  const embedBaseUrl = optionalCompassUrl(() => trustedCompassBaseUrl().origin);

  const capabilityPacks: CapabilityPackSettingsRow[] = rawCapabilityPacks.map((attachment) => ({
    packId: attachment.capabilityPackVersion.capabilityPack.packId,
    sourceRepository: attachment.capabilityPackVersion.sourceRepository,
    sourcePath: attachment.capabilityPackVersion.sourcePath,
    displayName: attachment.capabilityPackVersion.capabilityPack.displayName,
    enabled: attachment.enabled,
    selectedVersionId: attachment.capabilityPackVersionId,
    enabledSkillIds: JSON.parse(attachment.enabledSkillIds) as string[],
    versions: attachment.capabilityPackVersion.capabilityPack.versions.map((version) => ({
      id: version.id, version: version.semanticVersion, commit: version.sourceCommit, digest: version.artifactSha256,
      skills: (JSON.parse(version.manifestJson) as { skills: Array<{ id: string; enabledByDefault?: boolean }> }).skills,
    })),
  }));

  return (
    <main className="flex w-full min-w-0 flex-1 flex-col gap-8 p-4 sm:p-6 md:max-w-3xl md:p-8">
      <PageHeader title="Settings" description={workspace.name} />

      <SettingsSection title="Appearance" description="Choose how Compass looks on this device. System follows your operating system setting.">
        <ThemePreferenceControl />
      </SettingsSection>

      <SettingsSection title="Squads" description="Teams within this workspace. Squads can be assigned to objectives, opportunities, experiments, and roadmap items.">
        <ManageSquadsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialSquads={squads}
        />
      </SettingsSection>

      <SettingsSection title="Members" description="People with access to this workspace. Admins can manage settings, squads, and members; members have standard access.">
        <ManageMembersPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialMembers={members}
          currentUserMembershipId={currentUserMembershipId}
        />
      </SettingsSection>

      <SettingsSection title="Shared option sets" description="One editable picklist that any select or multi-select field can borrow — across different object types. Edit the list here and every field using it updates at once.">
        <SharedOptionSetsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          sets={sharedOptionSets}
        />
      </SettingsSection>

      <SettingsSection title="Custom Fields" description="Add fields to any object type. Click any field value on a record to edit it. Select fields can draw their options from a shared option set instead of keeping their own list.">
        <ManageFieldsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialFields={fields}
          sharedOptionSets={sharedOptionSets}
        />
      </SettingsSection>

      <SettingsSection title="Scoring" description="Choose which org-level scoring model this workspace uses to rank opportunities. Templates are managed by organization admins in Org Settings.">
        <WorkspaceScoringPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          availableModels={rawScoringModels}
          currentScoringModelId={scoringConfig?.scoringModelId ?? null}
        />
      </SettingsSection>

      <SettingsSection title="API Keys" description="Generate personal API keys for MCP / programmatic access. Each key is tied to your account and can be revoked independently.">
        <ManageApiKeysPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialKeys={apiKeys}
        />
      </SettingsSection>

      <SettingsSection title="Analytics" description="Bring aggregate usage evidence into product decisions without exposing credentials or customer identities.">
        <AnalyticsSettingsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialConnections={analyticsConnections}
          initialMetrics={analyticsMetrics}
          canManage={canManageCapabilityPacks}
        />
      </SettingsSection>

      <SettingsSection title="Workspace agents" description="Agents explicitly authorized in this workspace. Assignment does not grant access or start execution.">
        <WorkspaceAgentsPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} enabled={agentsEnabled()} canManage={canManageCapabilityPacks} agents={workspaceAgents.map((a) => ({ id: a.id, name: a.name, status: a.status, ownerName: rawMembers.find((m) => m.userId === a.ownerUserId)?.user.name ?? rawMembers.find((m) => m.userId === a.ownerUserId)?.user.email ?? "Former member", eligible: rawMembers.some((m) => m.userId === a.ownerUserId), access: grants.find((g) => g.agentId === a.id)?.access ?? null }))} />
      </SettingsSection>
      {canManageCapabilityPacks && <SettingsSection title="Workspace agent activity"><AgentActivity rows={agentActivity.map((r) => ({ ...r, agentName: workspaceAgents.find((a) => a.id === r.agentId)?.name ?? "Former workspace agent", workspaceName: workspace.name }))} /></SettingsSection>}

      {canManageCapabilityPacks && <SettingsSection title="Agent capability packs" description="Install validated skills-only packs for the in-app agent. Packs add instructions, never tools or credentials.">
        <CapabilityPacksPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} initialPacks={capabilityPacks} />
      </SettingsSection>}

      <SettingsSection title="Delivery limits" description="Optional WIP limits for the NOW and NEXT roadmap columns.">
        <DeliveryLimitsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          nowLimit={workspace.nowLimit ?? null}
          nextLimit={workspace.nextLimit ?? null}
        />
      </SettingsSection>

      <SettingsSection title="Portal" description="Control which parts of this workspace are publicly accessible without login.">
        <PortalSettingsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          feedbackEnabled={workspace.feedbackEnabled ?? false}
          roadmapPublic={workspace.roadmapPublic ?? false}
          portalAuthRequired={workspace.portalAuthRequired ?? false}
          ssoEnabled={workspace.ssoEnabled ?? false}
          ssoSecretConfigured={Boolean(workspace.ssoSecretEncrypted)}
          ssoSecretUpdatedAt={workspace.ssoSecretUpdatedAt}
        />
      </SettingsSection>

      {/*
        Placed after Portal, not before: several functional E2E specs
        (feedback-attachments, feedback-bug-roadmap, roadmap-unscheduled-items)
        select Portal's toggles by positional index
        (page.getByRole("switch").nth(1), etc.) since PortalSettingsPanel's
        toggles have no stable accessible name. Inserting a new switch above
        Portal would silently shift those indices and break those specs.
      */}
      <SettingsSection title="Marketing launch" description="Turn on launch tiers, checklists, and positioning briefs for teams that run a formal marketing-launch process.">
        <LaunchWorkflowSettingsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          launchWorkflowEnabled={workspace.launchWorkflowEnabled ?? false}
        />
      </SettingsSection>

      {/*
        Also after Portal, for the positional-index reason documented above: this
        section's per-source toggles would otherwise shift the indices those
        specs rely on.
      */}
      {canManageCapabilityPacks && <SettingsSection title="Embedded feedback" description="Let a prototype hosted elsewhere collect element-anchored feedback against an artifact in this workspace. Each source carries its own token and its own list of sites allowed to use it.">
        <FeedbackSourcesPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialSources={feedbackSources}
          artifacts={feedbackArtifacts}
          embedBaseUrl={embedBaseUrl}
          artifactFeedbackPublic={workspace.artifactFeedbackPublic ?? false}
        />
      </SettingsSection>}

      <SettingsSection title="Branding" description="Customize the accent color, font, and logo shown across this workspace and its public portal.">
        <WorkspaceBrandingPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialPaletteId={workspace.brandingPaletteId}
          initialPrimaryHex={workspace.brandingPrimaryHex}
          initialFontPresetId={workspace.brandingFontPresetId}
          initialFontFamily={workspace.brandingFontFamily}
          initialLogoUrl={workspace.brandingLogoUrl}
        />
      </SettingsSection>

      <SettingsSection danger title="Danger Zone" description="Destructive actions that cannot be undone.">
        <DeleteWorkspacePanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceName={workspace.name}
        />
      </SettingsSection>
    </main>
  );
}
