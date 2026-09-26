/**
 * Worked example: gate an app's main feature on verified GoatTown setup.
 *
 * Compiled and type-checked with the package so it cannot drift from the
 * exports it demonstrates. NOT exported from the public entry point —
 * copy it.
 *
 * The shape that matters is the gate. `ready` comes from the controller
 * and means four things were true in one pass: an authenticated call
 * succeeded, a revision is staged, that revision is active, and THIS app's
 * agent is in the catalog. The tempting shortcut — render the feature once
 * a service URL is saved — is what produces an app that looks configured
 * and fails on first use.
 *
 * ONE canonical configuration lives here, in `AGENT_YAML`. The same string
 * is staged by this panel and named by the running app, so the agent the
 * app asks for and the agent the configuration defines cannot drift apart.
 */
import { useState } from 'react';
import { SetupPanel } from './SetupPanel.js';

/** The agent this app requires. Referenced in both places below. */
export const AGENT_SLUG = 'demo-analyst';

/**
 * The app's bundled configuration — the single source of truth.
 *
 * No top-level `producer:`. The credential supplies it, and declaring one
 * is rejected with `producer_mismatch`.
 */
export function buildAgentYaml(dataset: string): string {
  return `version: 1

profiles:
  - slug: demo-reader
    displayName: "Demo reader"
    description: "Read-only access to the configured dataset."
    tools: [cribl-read]
    skills: []
    requiredSkills: []
    mcpTools: []
    net:
      hosts: ["$CRIBL_API_BASE"]
      apiPaths: []
      datasets: [${JSON.stringify(dataset)}]

agents:
  - slug: ${AGENT_SLUG}
    displayName: "Demo analyst"
    description: "Answers questions about the configured dataset."
    instructions: |
      Answer from the configured dataset only. Conclude by calling report
      exactly once, with a headline that states the answer directly.
    tools: [report]
    skills: []
    requiredSkills: []
    mcpTools: []
    inherits: [demo-reader]
    net: { hosts: [], apiPaths: [], datasets: [] }
    llm: {}
    triggerable: true
    authorizationGrants: []

skills: []
mcpServers: []
schedules: []
authorizationGrants: []
`;
}

export function DemoApp({ dataset = 'otel' }: { dataset?: string }) {
  // Held in state rather than read from a setting: the panel reports
  // verified readiness, and that is the only thing the gate trusts.
  const [ready, setReady] = useState(false);

  return (
    <div>
      <SetupPanel
        agentSlug={AGENT_SLUG}
        buildYaml={() => buildAgentYaml(dataset)}
        defaultServiceUrl="https://goattown-shared.lab.cribl.io"
        description="This app runs its questions through a GoatTown agent. Setup is one-time and shared with everyone in the workspace."
        onReady={setReady}
      />

      {ready ? (
        <MainFeature />
      ) : (
        // Deliberately not a spinner. The remaining work may belong to an
        // administrator, and a spinner implies the app is doing it.
        <p>Complete setup above to start asking questions.</p>
      )}
    </div>
  );
}

function MainFeature() {
  return <p>Ask a question…</p>;
}
