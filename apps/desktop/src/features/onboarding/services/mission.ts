import { academicPageIdentity, isReadNavigation } from '../lib/browser-policy';
import {
  assertMissionNavigation,
  isStaleNavigation,
  resolveMissionEntry,
} from '../lib/mission-policy';
import type { AcademicConnection, AgentActivity, EvidencePage } from '../types';

export type MissionSnapshot = {
  retrievedAt?: string;
  locale?: string | null;
  url: string;
  title: string;
  text: string;
  links: Array<{ label: string; url: string }>;
  password: boolean;
  error?: boolean;
};

type MissionTarget = { id: string; label: string; url: string };
type MissionExhaustionContext = {
  snapshot: MissionSnapshot;
  targets: MissionTarget[];
  evidence: EvidencePage[];
};

export type MissionChoice = {
  operation: 'NAVIGATE' | 'DONE' | 'BLOCKED';
  target: string | null;
  navigationHandled?: boolean;
};

export type MissionPageHandle = {
  goto: (url: string, options: { timeout: number }) => Promise<unknown>;
  url: () => Promise<string>;
};

type MissionDependencies = {
  connection: AcademicConnection;
  hosts: string[];
  page: MissionPageHandle;
  read: () => Promise<MissionSnapshot>;
  waitForReady: (signal: AbortSignal) => Promise<void>;
  choose: (
    evidence: EvidencePage[],
    targets: MissionTarget[],
  ) => Promise<MissionChoice | null>;
  addActivity: (activity: AgentActivity) => void;
  signal: AbortSignal;
  maxSteps?: number;
  disclose?: () => Promise<'opened' | 'not-found' | 'refused'>;
  isHostVerifiedCollectionExhausted?: (
    context: MissionExhaustionContext,
  ) => boolean;
};

export type MissionOutcome = 'done' | 'blocked' | 'empty' | 'budget';

export type MissionResult = {
  evidence: EvidencePage[];
  snapshots: MissionSnapshot[];
  outcome: MissionOutcome;
};

const isLoginPath = (url: string) =>
  /login|signin|oauth|saml/i.test(new URL(url).pathname);

const targetsFor = (
  snapshot: MissionSnapshot,
  hosts: string[],
  seen: Set<string>,
) =>
  snapshot.links
    .filter((link) => isReadNavigation(link.url, hosts) && !seen.has(link.url))
    .filter(
      (link, index, links) =>
        links.findIndex((item) => item.url === link.url) === index,
    )
    .slice(0, 60)
    .map((link, index) => ({ ...link, id: String(index + 1) }));

export const runReadOnlyMission = async ({
  connection,
  hosts,
  page,
  read,
  waitForReady,
  choose,
  addActivity,
  signal,
  maxSteps = 7,
  disclose,
  isHostVerifiedCollectionExhausted,
}: MissionDependencies): Promise<MissionResult> => {
  const entry = resolveMissionEntry(connection, hosts);
  if (entry.kind === 'unsupported') throw new Error(entry.message);
  const evidence: EvidencePage[] = [];
  const snapshots: MissionSnapshot[] = [];
  const seen = new Set<string>();
  const disclosedPages = new Set<string>();
  const capture = async () => {
    signal.throwIfAborted();
    await waitForReady(signal);
    signal.throwIfAborted();
    const pageUrl = await page.url();
    assertMissionNavigation(pageUrl, hosts);
    const snapshot = await read();
    signal.throwIfAborted();
    if (snapshot.password || isLoginPath(snapshot.url))
      throw new Error('This resource needs you to sign in again.');
    if (snapshot.error)
      throw new Error(
        'The page couldn’t load; check your connection and try again.',
      );
    assertMissionNavigation(snapshot.url, hosts);
    addActivity({ type: 'reading', detail: snapshot.title });
    snapshots.push(snapshot);
    const observedEvidence = {
      retrievedAt: snapshot.retrievedAt,
      locale: snapshot.locale,
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
    };
    const existingIndex = evidence.findIndex(
      (item) => item.url === snapshot.url,
    );
    if (existingIndex >= 0) evidence[existingIndex] = observedEvidence;
    else evidence.push(observedEvidence);
    seen.add(snapshot.url);
    return snapshot;
  };
  seen.add(entry.url);
  await page.goto(entry.url, { timeout: 12_000 });
  let outcome: MissionOutcome = 'budget';
  let navigated = true;
  for (let step = 0; step < maxSteps; step += 1) {
    navigated = false;
    let current = await capture();
    if (disclose && !disclosedPages.has(current.url)) {
      disclosedPages.add(current.url);
      signal.throwIfAborted();
      const disclosure = await disclose();
      signal.throwIfAborted();
      if (disclosure === 'opened') current = await capture();
    }
    const targets = targetsFor(current, hosts, seen);
    if (!targets.length) {
      outcome = 'empty';
      break;
    }
    const choice = await choose(evidence, targets);
    signal.throwIfAborted();
    if (!choice) throw new Error('Please sign in to ScholarOS again.');
    if (choice.operation === 'BLOCKED') {
      outcome = 'blocked';
      break;
    }
    if (choice.operation === 'DONE') {
      outcome = isHostVerifiedCollectionExhausted?.({
        snapshot: current,
        targets,
        evidence,
      })
        ? 'done'
        : 'blocked';
      break;
    }
    const selected = targets.find((target) => target.id === choice.target);
    if (
      choice.operation !== 'NAVIGATE' ||
      !selected ||
      !isReadNavigation(selected.url, hosts)
    )
      throw new Error('The agent could not choose a permitted page.');
    addActivity({ type: 'navigating', detail: selected.label });
    seen.add(selected.url);
    if (choice.navigationHandled) {
      const destination = await page.url();
      assertMissionNavigation(destination, hosts);
      if (
        academicPageIdentity(destination) !== academicPageIdentity(selected.url)
      )
        throw new Error('The read action reached an unexpected page.');
    } else {
      const fresh = await read();
      signal.throwIfAborted();
      if (isStaleNavigation(current.url, fresh, selected)) continue;
      await page.goto(selected.url, { timeout: 12_000 });
    }
    navigated = true;
  }
  // The last permitted navigation must be observed before model extraction.
  if (navigated) await capture();
  return { evidence, snapshots, outcome };
};
