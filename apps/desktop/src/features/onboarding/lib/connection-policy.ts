import { academicPageIdentity, isReadNavigation } from './browser-policy';
import type { AcademicConnection, ConnectionStatus } from '../types';

export type CapturedPageEvidence = {
  origin: string;
  host: string;
  pathname: string;
  href: string;
  title: string;
  hasPasswordField: boolean;
  hasCanvasMarkers: boolean;
  courseLinkCount: number;
};

const signInPathPattern =
  /(?:login|signin|sign-in|oauth|sso|saml|authorize|callback)/i;
const signInHostPattern =
  /(?:accounts\.google|login\.microsoftonline|okta|auth0)\./i;
const canvasHostPattern = /canvas|instructure|bcourses/;

const refuseUnreadablePage =
  'Finish signing in, then open your course dashboard before connecting this site.';

export const isSignInPage = (host: string, pathname: string) =>
  signInPathPattern.test(pathname) || signInHostPattern.test(host);

export const classifyCapturedPage = (
  evidence: CapturedPageEvidence,
): Pick<AcademicConnection, 'name' | 'url' | 'host' | 'kind' | 'status'> => {
  const identity = academicPageIdentity(evidence.href);
  if (
    isSignInPage(evidence.host, evidence.pathname) ||
    evidence.hasPasswordField ||
    !identity ||
    !isReadNavigation(identity, [evidence.host])
  )
    throw new Error(refuseUnreadablePage);
  const kind =
    evidence.host === 'classroom.google.com'
      ? 'classroom'
      : evidence.hasCanvasMarkers ||
          evidence.courseLinkCount > 0 ||
          canvasHostPattern.test(evidence.host)
        ? 'canvas'
        : 'resource';
  const verified =
    kind === 'canvas' &&
    (evidence.hasCanvasMarkers || evidence.courseLinkCount > 0);
  const status: ConnectionStatus = verified ? 'verified' : 'needs-sign-in';
  return {
    // The identity keeps the query and fragment that distinguish this page and
    // drops only credential parameters, so the agent reopens the same view.
    url: identity,
    host: evidence.host,
    name: evidence.title.trim().slice(0, 140) || evidence.host,
    kind,
    status,
  };
};
