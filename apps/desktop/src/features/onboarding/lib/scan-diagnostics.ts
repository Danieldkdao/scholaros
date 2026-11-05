import type { HostCourseCollectionCoverageEvidence } from '../../courses/types';

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
