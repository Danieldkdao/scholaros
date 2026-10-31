import { randomUUID } from 'node:crypto';
import {
  connectionCandidateSchema,
  type ConnectionCandidateSchema,
} from '@scholaros/services/ai/schemas';
import { isAcademicUrl, isReadNavigation } from '../lib/browser-policy';

type Proposal = {
  id: string;
  candidates: ConnectionCandidateSchema[];
};

type StoredProposal = Proposal & {
  accountId: string;
  expiresAt: number;
  approved: boolean;
};

export const validateConnectionCandidates = (
  input: unknown,
): ConnectionCandidateSchema[] => {
  if (!Array.isArray(input) || input.length > 8)
    throw new Error('Choose up to eight sites.');
  const candidates = input.map((value) => {
    const candidate = connectionCandidateSchema.parse(value);
    if (!isAcademicUrl(candidate.url))
      throw new Error('Choose a secure public website.');
    const url = new URL(candidate.url);
    if (!isReadNavigation(url.href, [url.hostname]))
      throw new Error('Choose a read-only website address.');
    return { ...candidate, url: url.href };
  });
  if (
    new Set(candidates.map((candidate) => new URL(candidate.url).hostname))
      .size !== candidates.length
  )
    throw new Error('Each site can only be listed once.');
  return candidates;
};

export const createConnectionApprovalStore = () => {
  let active: StoredProposal | null = null;
  const get = (accountId: string, id: string) => {
    if (
      !active ||
      active.id !== id ||
      active.accountId !== accountId ||
      active.expiresAt <= Date.now()
    )
      throw new Error('This connection approval has expired; start again.');
    return active;
  };
  const propose = (accountId: string, input: unknown): Proposal => {
    const candidates = validateConnectionCandidates(input);
    active = {
      id: randomUUID(),
      accountId,
      candidates,
      expiresAt: Date.now() + 5 * 60_000,
      approved: false,
    };
    return {
      id: active.id,
      candidates: structuredClone(candidates),
    };
  };
  const revise = (accountId: string, id: string, input: unknown) => {
    const proposal = get(accountId, id);
    proposal.approved = false;
    return propose(accountId, input);
  };
  const approve = (accountId: string, id: string, input: unknown) => {
    const proposal = get(accountId, id);
    const candidates = validateConnectionCandidates(input);
    if (
      !candidates.length ||
      JSON.stringify(candidates) !== JSON.stringify(proposal.candidates)
    )
      throw new Error('Review the sites before approving them.');
    proposal.approved = true;
  };
  const consume = (accountId: string, id: string) => {
    const proposal = get(accountId, id);
    if (!proposal.approved)
      throw new Error('Approve the sites before continuing.');
    active = null;
    return structuredClone({
      candidates: proposal.candidates,
    });
  };
  const reset = () => {
    active = null;
  };
  return { propose, revise, approve, consume, reset };
};
