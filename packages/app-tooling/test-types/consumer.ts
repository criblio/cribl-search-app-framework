/**
 * Type-level consumer of every app-tooling subpath except `./playwright`
 * (its optional `@playwright/test` peer is not installed here; its d.ts
 * is exercised by apps that have it). Not run, only compiled.
 */
import * as root from '@criblio/app-tooling';
import { createAppPack, packageApp, type AppPackStream } from '@criblio/app-tooling/pack';
import { backendScripts, formatInspection, inspectPack, type PackInspection } from '@criblio/app-tooling/inspect';
import { diffProxies, parseProxiesYaml, validateProxies, type ParsedProxies } from '@criblio/app-tooling/proxies';
import { deployApp, installUploadedPack, type DeployDryRunResult, type DeployResult } from '@criblio/app-tooling/deploy';
import { createReleaseEvidence, type ReleaseMetadata } from '@criblio/app-tooling/release-evidence';
import { runStaticSecurityChecks } from '@criblio/app-tooling/security';

export async function exercise(): Promise<void> {
  const parsed: ParsedProxies = parseProxiesYaml('api.example.com:\n  timeout: 5000\n');
  const problems: string[] = validateProxies(parsed);
  const diffs: string[] = diffProxies(parsed, {}, { actualLabel: 'a', expectedLabel: 'b' });
  const report: PackInspection = await inspectPack('build/app.tgz', { root: '.', proxiesManifest: 'p.yml' });
  const line: string = formatInspection(report);
  const scripts: string[] = backendScripts('- script: backend/a.js');
  const stream: AppPackStream = await createAppPack({ dev: true });
  await stream.closePromise;
  const artifact: string = await packageApp();
  const deployed: DeployResult = await deployApp({ requireEmptyProxies: true, provision: false });
  const planned: DeployDryRunResult = await deployApp({ dryRun: true });
  const action: string = planned.dryRun.action;
  const installed = await installUploadedPack({ baseUrl: 'https://x', token: 't', source: 's', pkg: { name: 'n', version: '1.0.0' } });
  const meta: ReleaseMetadata = await createReleaseEvidence({ artifact });
  await runStaticSecurityChecks('.');
  const fromRoot: string[] = root.diffProxies(root.parseProxiesYaml(''), null);
  void [problems, diffs, line, scripts, deployed, action, installed.warning, meta.artifact_sha256, fromRoot];
}

// @ts-expect-error — options are typed, not `any`
void inspectPack('a.tgz', { requireEmptyProxies: 'yes' });
