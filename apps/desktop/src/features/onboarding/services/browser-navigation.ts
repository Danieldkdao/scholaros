import type { Stagehand, Page } from '@browserbasehq/stagehand';
import type { BrowserNavigationMode } from '@scholaros/env/browser-navigation';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import { createDecisionNavigationAdapter } from './decision-navigation';
import { createInoutNavigationAdapter } from './inout-navigation';

export type ResourceExtractionRequest = AgentRequestSchema & {
  kind: 'courses' | 'assignments' | 'announcements' | 'materials';
};

export type BrowserNavigationChoice = {
  operation: 'NAVIGATE' | 'DONE' | 'BLOCKED';
  target: string | null;
  navigationHandled?: boolean;
};

export type BrowserNavigationDependencies = {
  page: Page;
  stagehand?: Stagehand;
  hosts: string[];
  signal: AbortSignal;
  isCurrent: () => boolean;
  assertReadable: () => void;
  onWait?: (milliseconds: number) => void;
};

export type BrowserNavigationAdapter = {
  discoverCourses: (input: {
    goal: string;
    notes: string;
    pages: AgentRequestSchema['pages'];
    targets: NonNullable<AgentRequestSchema['targets']>;
  }) => Promise<string[]>;
  choose: (input: {
    goal: string;
    notes: string;
    memory?: AgentRequestSchema['memory'];
    pages: AgentRequestSchema['pages'];
    targets: NonNullable<AgentRequestSchema['targets']>;
  }) => Promise<BrowserNavigationChoice | null>;
  extract: (request: ResourceExtractionRequest) => Promise<unknown>;
};

export const createBrowserNavigationAdapter = (
  mode: BrowserNavigationMode,
  dependencies: BrowserNavigationDependencies,
): BrowserNavigationAdapter => {
  switch (mode) {
    case 'decision':
      return createDecisionNavigationAdapter(dependencies);
    case 'inout':
      return createInoutNavigationAdapter(dependencies);
  }
};
