import type { HostCourseCollectionCoverageEvidence } from '../../courses/types';

export const scanFailureReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  switch (message) {
    case 'The current page changed before browser inference.':
      return 'pre-inference-document-changed';
    case 'The current page changed during course navigation.':
      return 'post-navigation-document-changed';
    case 'The page changed before inout extraction.':
      return 'pre-extraction-document-changed';
    case 'The page changed outside the verified course scope.':
      return 'post-extraction-scope-changed';
    case 'The read action reached an unexpected page.':
      return 'read-action-destination-mismatch';
    case 'The inout action reached an unexpected course page.':
      return 'readback-destination-mismatch';
  }
  if (
    /Cannot find (?:execution )?context|Execution context (?:was )?destroyed/i.test(
      message,
    )
  )
    return 'document-context-replaced';
  if (/didn.t finish loading|did not finish loading/i.test(message))
    return 'document-not-ready';
  if (/background study tab could not be opened/i.test(message))
    return 'background-tab-unavailable';
  if (/requested course could not be verified/i.test(message))
    return 'course-route-unverified';
  if (/page changed|unexpected.*page|changed during navigation/i.test(message))
    return 'document-changed';
  if (
    /schema|unsupported browser response|unreadable course data/i.test(
      message,
    ) ||
    (error instanceof Error && error.name === 'ZodError')
  )
    return 'invalid-model-output';
  if (/scope|approved course|course membership/i.test(message))
    return 'course-scope-unverified';
  if (
    /not found|no longer.*(?:link|visible)|could not.*(?:open|load)/i.test(
      message,
    )
  )
    return 'destination-unavailable';
  if (/sign in|password/i.test(message)) return 'sign-in-required';
  if (/rate.?limit|quota|429|slow down/i.test(message)) return 'rate-limited';
  if (/timeout|timed out/i.test(message)) return 'timed-out';
  return 'unknown';
};

export const scanDiagnosticMessages = {
  noCourseLinks:
    'Refresh detail: the connected page exposed no readable course links. Open your course list in the study browser, then retry.',
  unrecognizedCourses:
    'Refresh detail: the page loaded, but no enrolled course links were recognized. Open the full course list in the study browser, then retry.',
  blockedRequiredData:
    'Refresh detail: required school data was blocked by the current connection scope. Review your connected school resources, then retry.',
  unverifiedCollection:
    'Refresh detail: reading stopped before this collection could be verified. Open the assignments or announcements list in the study browser, then retry.',
  pendingPages:
    'Refresh detail: more collection pages remain unread. Refresh again to continue.',
  readingLimit:
    'Refresh detail: the collection reached its reading limit. Refresh again to continue.',
  invalidRecords:
    'Refresh detail: some course records could not be verified. Existing records were kept; refresh again.',
  ambiguousIdentity:
    'Refresh detail: conflicting course item identities were found. Existing records were kept.',
} as const;
const allowedMessages = new Set<string>(Object.values(scanDiagnosticMessages));
export const safeScanDiagnostic = (value: string) =>
  allowedMessages.has(value) ? value : null;

export const collectionScanDiagnostic = (scan: {
  status: string;
  hostCoverage?: HostCourseCollectionCoverageEvidence | null;
}) => {
  if (scan.status !== 'partial') return null;
  const gaps = scan.hostCoverage?.gaps;
  if (gaps?.blockedRequiredData)
    return scanDiagnosticMessages.blockedRequiredData;
  if (gaps?.pendingPagination) return scanDiagnosticMessages.pendingPages;
  if (gaps?.truncated) return scanDiagnosticMessages.readingLimit;
  if (gaps?.invalidRecords) return scanDiagnosticMessages.invalidRecords;
  if (gaps?.ambiguousIdentity) return scanDiagnosticMessages.ambiguousIdentity;
  return scanDiagnosticMessages.unverifiedCollection;
};
