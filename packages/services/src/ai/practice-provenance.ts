import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export type PracticeProvenanceScope = {
  accountId: string;
  courseId: string;
  sessionId: string;
  configurationRevision: string;
  rubricVersion: string;
  question: unknown;
  answerKey: unknown;
};
const lifetimeMs = 7 * 24 * 60 * 60 * 1000;
const maximumProofBytes = 4096;
const maximumContentBytes = 1024 * 1024;
const signatureDomain = 'scholaros.practice-proof.v1.';
const invalid = () => new Error('Invalid practice provenance input.');
// JSON-only, bounded canonicalization prevents order-dependent or ambiguous proofs.
const canonical = (value: unknown, omitGenerationProof = false): string => {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number, omit: boolean): string => {
    if (++nodes > 20_000 || depth > 32) throw invalid();
    if (item === null) return 'null';
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalid();
      return JSON.stringify(item);
    }
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item, 'utf8');
      if (bytes > maximumContentBytes) throw invalid();
      return JSON.stringify(item);
    }
    if (typeof item !== 'object' || seen.has(item)) throw invalid();
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw invalid();
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 20_000 || Object.keys(item).length !== item.length)
          throw invalid();
        return `[${Array.from({ length: item.length }, (_, index) => {
          const property = Object.getOwnPropertyDescriptor(item, String(index));
          if (!property || !('value' in property)) throw invalid();
          return visit(property.value, depth + 1, false);
        }).join(',')}]`;
      }
      const keys = Object.keys(item)
        .filter((key) => !omit || key !== 'generationProof')
        .sort();
      return `{${keys
        .map((key) => {
          bytes += Buffer.byteLength(key, 'utf8');
          if (bytes > maximumContentBytes) throw invalid();
          const property = Object.getOwnPropertyDescriptor(item, key);
          if (!property || !('value' in property)) throw invalid();
          return `${JSON.stringify(key)}:${visit(property.value, depth + 1, false)}`;
        })
        .join(',')}}`;
    } finally {
      seen.delete(item);
    }
  };
  const result = visit(value, 0, omitGenerationProof);
  if (Buffer.byteLength(result, 'utf8') > maximumContentBytes) throw invalid();
  return result;
};
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const scopeDigest = (scope: PracticeProvenanceScope) => {
  if (!scope || typeof scope !== 'object') throw invalid();
  for (const field of [
    'accountId',
    'courseId',
    'sessionId',
    'configurationRevision',
    'rubricVersion',
  ] as const) {
    if (
      typeof scope[field] !== 'string' ||
      scope[field].trim().length === 0 ||
      scope[field].length > 4096
    )
      throw invalid();
  }
  return digest(
    canonical({
      accountId: scope.accountId,
      courseId: scope.courseId,
      sessionId: scope.sessionId,
      configurationRevision: scope.configurationRevision,
      rubricVersion: scope.rubricVersion,
      question: digest(canonical(scope.question)),
      answerKey: digest(canonical(scope.answerKey, true)),
    }),
  );
};
const validTime = (value: number) =>
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER - lifetimeMs;
const validSecret = (secret: string) =>
  typeof secret === 'string' && secret.trim().length > 0;
const mac = (payload: string, secret: string) =>
  createHmac('sha256', secret)
    .update(signatureDomain + payload)
    .digest();
export const issuePracticeProof = (
  scope: PracticeProvenanceScope,
  secret: string,
  nowMs = Date.now(),
): string => {
  if (!validSecret(secret) || !validTime(nowMs)) throw invalid();
  const payload = Buffer.from(
    canonical({
      v: 1,
      iat: nowMs,
      exp: nowMs + lifetimeMs,
      d: scopeDigest(scope),
    }),
  ).toString('base64url');
  const proof = `v1.${payload}.${mac(payload, secret).toString('base64url')}`;
  if (Buffer.byteLength(proof, 'utf8') > maximumProofBytes) throw invalid();
  return proof;
};
export const verifyPracticeProof = (
  scope: PracticeProvenanceScope,
  proof: unknown,
  secret: string,
  nowMs = Date.now(),
): boolean => {
  try {
    if (
      !validSecret(secret) ||
      !validTime(nowMs) ||
      typeof proof !== 'string' ||
      proof.length > maximumProofBytes
    )
      return false;
    const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(proof);
    if (!match) return false;
    const payload = match[1]!;
    const signature = Buffer.from(match[2]!, 'base64url');
    if (
      signature.length !== 32 ||
      signature.toString('base64url') !== match[2] ||
      !timingSafeEqual(signature, mac(payload, secret))
    )
      return false;
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) return false;
    const text = bytes.toString('utf8');
    const parsed = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'd,exp,iat,v'
    )
      return false;
    if (
      parsed.v !== 1 ||
      !validTime(parsed.iat) ||
      parsed.exp !== parsed.iat + lifetimeMs ||
      parsed.iat > nowMs ||
      parsed.exp <= nowMs ||
      typeof parsed.d !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.d)
    )
      return false;
    if (canonical(parsed) !== text) return false;
    return timingSafeEqual(
      Buffer.from(parsed.d, 'hex'),
      Buffer.from(scopeDigest(scope), 'hex'),
    );
  } catch {
    return false;
  }
};
