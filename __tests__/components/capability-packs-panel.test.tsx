// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CapabilityPacksPanel, type CapabilityPackSettingsRow } from "@/components/settings/capability-packs-panel"

const { install, update, curated, check, upgrade } = vi.hoisted(() => ({ install: vi.fn(), update: vi.fn(), curated: vi.fn(), check: vi.fn(), upgrade: vi.fn() }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/capability-pack-actions", () => ({
  installWorkspaceCapabilityPack: install,
  updateWorkspaceCapabilityPack: update,
  installAgenticPmCapabilityPack: curated,
  checkAgenticPmPackUpdate: check,
  updateAgenticPmCapabilityPack: upgrade,
}))
const pack: CapabilityPackSettingsRow = {
  packId: "sample.product", displayName: "Sample Product Skills", enabled: true, sourceRepository: "https://github.com/example/skills", sourcePath: "packs/compass",
  selectedVersionId: "v2", enabledSkillIds: ["discovery"],
  versions: [
    { id: "v2", version: "2.0.0", commit: "b".repeat(40), digest: "b".repeat(64), skills: [{ id: "discovery" }, { id: "report" }] },
    { id: "v1", version: "1.0.0", commit: "a".repeat(40), digest: "a".repeat(64), skills: [{ id: "report" }, { id: "discovery", enabledByDefault: false }] },
  ],
}
const panel = () => <CapabilityPacksPanel orgSlug="sample" workspaceSlug="product" initialPacks={[pack]} />
afterEach(cleanup)
beforeEach(() => { vi.resetAllMocks(); install.mockResolvedValue({ id: "v2" }); update.mockResolvedValue(undefined); check.mockResolvedValue({ error: "Unable to check for Agentic PM pack updates." }) })

describe("capability pack settings", () => {
  it("offers one-click installation with manual source fields collapsed under Advanced", async () => {
    curated.mockResolvedValue({ installed: true })
    render(panel())
    expect(screen.queryByRole("textbox", { name: "GitHub repository URL" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Install Agentic PM pack" }))
    await waitFor(() => expect(curated).toHaveBeenCalledWith("sample", "product"))
    expect(await screen.findByRole("button", { name: "Agentic PM pack installed" })).toBeDisabled()
    fireEvent.click(screen.getByText("Advanced"))
    expect(screen.getByRole("textbox", { name: "GitHub repository URL" })).toBeVisible()
  })
  it("does not mistake an alternate source with the same pack ID for the curated installation", () => {
    render(<CapabilityPacksPanel orgSlug="sample" workspaceSlug="product" initialPacks={[{ ...pack, packId: "agentic-pm-compass" }]} />)
    expect(screen.getByRole("button", { name: "Install Agentic PM pack" })).toBeEnabled()
  })
  it("shows an existing disabled curated installation without re-enabling or resetting it", () => {
    render(<CapabilityPacksPanel orgSlug="sample" workspaceSlug="product" initialPacks={[{ ...pack, packId: "agentic-pm-compass", sourceRepository: "https://github.com/rbcodelabs/agent-pm-playbook", enabled: false }]} />)
    expect(screen.getByRole("button", { name: "Agentic PM pack installed" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled()
    expect(curated).not.toHaveBeenCalled()
  })
  it("renders serialized server validation failures in production", async () => {
    install.mockResolvedValue({ error: "A full 40-character commit SHA is required" })
    render(panel())
    fireEvent.click(screen.getByText("Advanced"))
    fireEvent.change(screen.getByRole("textbox", { name: "GitHub repository URL" }), { target: { value: "https://github.com/sample/product" } })
    fireEvent.change(screen.getByRole("textbox", { name: "Full commit SHA" }), { target: { value: "main" } })
    fireEvent.click(screen.getByRole("button", { name: "Install and enable" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("A full 40-character commit SHA is required")
  })
  it("keeps the persisted skill selection when an update fails", async () => {
    update.mockRejectedValue(new Error("Update unavailable"))
    render(panel())
    fireEvent.click(screen.getByRole("checkbox", { name: "discovery" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Update unavailable")
    expect(screen.getByRole("checkbox", { name: "discovery" })).toBeChecked()
    expect(update).toHaveBeenCalledWith("sample", "product", { packVersionId: "v2", enabledSkillIds: [], enabled: true })
  })

  it("sends enabled skill IDs and displays the revalidated selection", async () => {
    const view = render(panel())
    fireEvent.click(screen.getByRole("checkbox", { name: "report" }))
    await waitFor(() => expect(update).toHaveBeenCalledWith("sample", "product", { packVersionId: "v2", enabledSkillIds: ["discovery", "report"], enabled: true }))
    view.rerender(<CapabilityPacksPanel orgSlug="sample" workspaceSlug="product" initialPacks={[{ ...pack, enabledSkillIds: ["discovery", "report"] }]} />)
    expect(screen.getByRole("checkbox", { name: "report" })).toBeChecked()
  })

  it("keeps the persisted version when rollback fails", async () => {
    update.mockRejectedValue(new Error("Rollback unavailable"))
    render(panel())
    fireEvent.change(screen.getByRole("combobox", { name: "Version" }), { target: { value: "v1" } })
    expect(await screen.findByRole("alert")).toHaveTextContent("Rollback unavailable")
    expect(screen.getByRole("combobox", { name: "Version" })).toHaveValue("v2")
    expect(update).toHaveBeenCalledWith("sample", "product", { packVersionId: "v1", enabledSkillIds: ["report"], enabled: true })
  })

  it("disables configuration controls while a mutation is pending", async () => {
    let resolve!: () => void
    update.mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    render(panel())
    fireEvent.click(screen.getByRole("button", { name: "Disable" }))
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "report" })).toHaveAttribute("aria-disabled", "true"))
    expect(screen.getByRole("combobox", { name: "Version" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Install Agentic PM pack" })).toBeDisabled()
    resolve()
    await waitFor(() => expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled())
  })

  it("submits the exact immutable source and displays installation errors", async () => {
    install.mockRejectedValue(new Error("Invalid commit SHA"))
    render(panel())
    fireEvent.click(screen.getByText("Advanced"))
    fireEvent.change(screen.getByRole("textbox", { name: "GitHub repository URL" }), { target: { value: "https://github.com/sample/product" } })
    fireEvent.change(screen.getByRole("textbox", { name: "Full commit SHA" }), { target: { value: "not-a-commit" } })
    fireEvent.click(screen.getByRole("button", { name: "Install and enable" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid commit SHA")
    expect(install).toHaveBeenCalledWith("sample", "product", { repositoryUrl: "https://github.com/sample/product", commitSha: "not-a-commit", packPath: "packs/compass" })
  })

  describe("Agentic PM update check", () => {
    const curatedPack: CapabilityPackSettingsRow = { ...pack, packId: "agentic-pm-compass", sourceRepository: "https://github.com/rbcodelabs/agent-pm-playbook", selectedVersionId: "c1" }
    const curatedPanel = () => <CapabilityPacksPanel orgSlug="sample" workspaceSlug="product" initialPacks={[curatedPack]} />
    it("never checks GitHub when the curated pack is not installed", () => {
      render(panel())
      expect(check).not.toHaveBeenCalled()
    })
    it("shows the installed and latest commits and updates on request", async () => {
      check.mockResolvedValue({ installedCommit: "a".repeat(40), latestCommit: "b".repeat(40), updateAvailable: true })
      upgrade.mockResolvedValue({ updated: true, commit: "b".repeat(40) })
      render(curatedPanel())
      expect(await screen.findByText(/Update available/)).toHaveTextContent("aaaaaaaa")
      expect(screen.getByText(/Update available/)).toHaveTextContent("bbbbbbbb")
      fireEvent.click(screen.getByRole("button", { name: "Update to latest" }))
      await waitFor(() => expect(upgrade).toHaveBeenCalledWith("sample", "product"))
    })
    it("reports up to date without offering an update", async () => {
      check.mockResolvedValue({ installedCommit: "a".repeat(40), latestCommit: "a".repeat(40), updateAvailable: false })
      render(curatedPanel())
      expect(await screen.findByText(/up to date/)).toBeVisible()
      expect(screen.queryByRole("button", { name: "Update to latest" })).not.toBeInTheDocument()
    })
    it("degrades quietly when the check fails", async () => {
      check.mockRejectedValue(new Error("boom"))
      render(curatedPanel())
      expect(await screen.findByText("Unable to check for Agentic PM pack updates.")).toBeVisible()
      expect(screen.queryByRole("button", { name: "Update to latest" })).not.toBeInTheDocument()
    })
    it("surfaces an update failure and keeps the button available for retry", async () => {
      check.mockResolvedValue({ installedCommit: "a".repeat(40), latestCommit: "b".repeat(40), updateAvailable: true })
      upgrade.mockResolvedValue({ error: "Unable to update the Agentic PM pack. Your installed version is unchanged." })
      render(curatedPanel())
      fireEvent.click(await screen.findByRole("button", { name: "Update to latest" }))
      expect(await screen.findByRole("alert")).toHaveTextContent("installed version is unchanged")
      // The alert renders before the transition that disables the button settles, so assert the end state.
      await waitFor(() => expect(screen.getByRole("button", { name: "Update to latest" })).toBeEnabled())
    })
  })
})
