/**
 * UI connection indicators must not conflate a running local API with a
 * validated Salesforce metadata repository. All three statuses are independent.
 */
export function repositoryConnectionIndicator(
  apiConnected: boolean,
  repositoryChecked: boolean,
  repositoryReady: boolean,
): { connected: boolean; label: string } {
  if (!apiConnected) return { connected: false, label: "Repository unavailable" };
  if (!repositoryChecked) return { connected: false, label: "Repository checking…" };
  if (!repositoryReady) return { connected: false, label: "Repository not configured" };
  return { connected: true, label: "Repository connected" };
}
