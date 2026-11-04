import { z } from 'zod';
import { contentCoverageValues, sourceEvidenceSchema } from './shared';
import type { AgentRequestSchema } from '../schemas';

export const materialSourceTypes = [
  'syllabus',
  'reading',
  'lecture',
  'document',
  'page',
  'pdf',
  'unknown',
] as const;
export type MaterialSourceType = (typeof materialSourceTypes)[number];

export const materialReadabilityValues = [
  'readable',
  'truncated',
  'unreadable',
] as const;
export type MaterialReadability = (typeof materialReadabilityValues)[number];

export const materialSourceTypeSchema = z.enum(materialSourceTypes);
export type MaterialSourceTypeSchema = z.infer<typeof materialSourceTypeSchema>;

export const materialReadabilitySchema = z.enum(materialReadabilityValues);
export type MaterialReadabilitySchema = z.infer<
  typeof materialReadabilitySchema
>;

export const extractedMaterialSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  sourceType: materialSourceTypeSchema,
  url: z.url().max(2048),
  readability: materialReadabilitySchema,
  summary: z.string().trim().min(1).max(2000).nullable(),
  summaryEvidence: z.array(z.string().trim().min(1).max(350)).max(4),
  evidence: sourceEvidenceSchema,
});
export type ExtractedMaterialSchema = z.infer<typeof extractedMaterialSchema>;

export const extractedMaterialsSchema = z.strictObject({
  materials: z.array(extractedMaterialSchema).max(30),
  coverage: z.enum(contentCoverageValues),
});
export type ExtractedMaterialsSchema = z.infer<typeof extractedMaterialsSchema>;

const normalize = (value: string) =>
  value.replace(/\s+/g, ' ').trim().toLowerCase();
const ignoredSummaryTerms = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'these',
  'those',
  'are',
  'was',
  'were',
  'has',
  'have',
  'into',
  'about',
  'your',
]);
const significantWords = (value: string) =>
  (normalize(value).match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (word) => !ignoredSummaryTerms.has(word),
  );

const safeMaterialUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
};

const isWithinCourseScope = (sourceUrl: string, courseUrl: string) => {
  try {
    const safeSourceUrl = safeMaterialUrl(sourceUrl);
    const safeCourseUrl = safeMaterialUrl(courseUrl);
    if (!safeSourceUrl || !safeCourseUrl) return false;
    const source = new URL(safeSourceUrl);
    const course = new URL(safeCourseUrl);
    const coursePath = course.pathname.replace(/\/+$/, '');
    return (
      source.origin === course.origin &&
      (source.pathname === coursePath ||
        source.pathname.startsWith(`${coursePath}/`))
    );
  } catch {
    return false;
  }
};

const containsExactSourceText = (source: string, excerpt: string) =>
  normalize(source).includes(normalize(excerpt));

const summaryIsSupported = (summary: string | null, evidence: string[]) => {
  if (!summary) return evidence.length === 0;
  if (!evidence.length) return false;
  const sentences = summary.split(/(?<=[.!?])\s+/u).filter(Boolean);
  return sentences.every((sentence) => {
    const words = significantWords(sentence);
    return (
      words.length > 0 &&
      evidence.some((excerpt) => {
        const sourceWords = new Set(significantWords(excerpt));
        return words.every((word) => sourceWords.has(word));
      })
    );
  });
};

export const validateMaterialExtraction = (
  input: AgentRequestSchema,
  raw: unknown,
  options: { courseMembershipVerified?: boolean } = {},
): ExtractedMaterialsSchema => {
  const envelope = extractedMaterialsSchema.safeParse(raw);
  if (!envelope.success) return { materials: [], coverage: 'partial' };
  let invalid =
    envelope.data.materials.length >= 30 ||
    (envelope.data.materials.length === 0 &&
      envelope.data.coverage === 'complete');
  const materials: ExtractedMaterialSchema[] = [];
  const seen = new Map<string, ExtractedMaterialSchema>();
  const targets = input.targets ?? [];
  for (const material of envelope.data.materials) {
    const page = input.pages.find(
      (candidate) => candidate.url === material.evidence.sourceUrl,
    );
    if (!page) {
      invalid = true;
      continue;
    }
    const pageIdentity = safeMaterialUrl(page.url);
    const courseIdentity = input.context?.courseUrl
      ? safeMaterialUrl(input.context.courseUrl)
      : null;
    const materialIdentity = safeMaterialUrl(material.url);
    if (
      !pageIdentity ||
      !materialIdentity ||
      (input.context?.courseUrl && !courseIdentity)
    ) {
      invalid = true;
      continue;
    }
    const pageText = `${page.title}\n${page.text}`;
    const sourceTargets = targets.filter((target) =>
      material.evidence.targetIds.includes(target.id),
    );
    const sourceText = [
      pageText,
      ...sourceTargets.flatMap((target) => [
        target.label,
        target.context ?? '',
      ]),
    ].join('\n');
    const offeredUrl =
      materialIdentity === pageIdentity ||
      targets.some(
        (target) =>
          safeMaterialUrl(target.url) === materialIdentity &&
          material.evidence.targetIds.includes(target.id),
      );
    const courseUrl = courseIdentity;
    const inCourseScope =
      !courseUrl ||
      isWithinCourseScope(pageIdentity, courseUrl) ||
      options.courseMembershipVerified === true;
    const evidenceValid =
      material.evidence.targetIds.every((id) =>
        targets.some((target) => target.id === id),
      ) &&
      material.evidence.excerpts.every((excerpt) =>
        containsExactSourceText(sourceText, excerpt),
      ) &&
      material.summaryEvidence.every(
        (excerpt) =>
          material.evidence.excerpts.some(
            (evidence) => normalize(evidence) === normalize(excerpt),
          ) && containsExactSourceText(sourceText, excerpt),
      );
    const titleValid = containsExactSourceText(sourceText, material.title);
    const summaryValid = summaryIsSupported(
      material.summary,
      material.summaryEvidence,
    );
    const readabilityValid =
      material.readability !== 'unreadable' ||
      (material.summary === null && material.summaryEvidence.length === 0);
    if (
      !offeredUrl ||
      !inCourseScope ||
      !evidenceValid ||
      !titleValid ||
      !summaryValid ||
      !readabilityValid
    ) {
      invalid = true;
      continue;
    }
    if (material.readability === 'truncated') invalid = true;
    const identity = materialIdentity;
    const existingMaterial = seen.get(identity);
    if (existingMaterial) {
      const sameRecord =
        existingMaterial.title === material.title &&
        existingMaterial.sourceType === material.sourceType &&
        existingMaterial.readability === material.readability &&
        existingMaterial.summary === material.summary;
      if (!sameRecord) {
        invalid = true;
        materials.push(material);
        continue;
      }
      const excerpts = [
        ...new Set([
          ...existingMaterial.evidence.excerpts,
          ...material.evidence.excerpts,
        ]),
      ];
      const targetIds = [
        ...new Set([
          ...existingMaterial.evidence.targetIds,
          ...material.evidence.targetIds,
        ]),
      ];
      const summaryEvidence = [
        ...new Set([
          ...existingMaterial.summaryEvidence,
          ...material.summaryEvidence,
        ]),
      ];
      if (
        excerpts.length > 4 ||
        targetIds.length > 30 ||
        summaryEvidence.length > 4
      ) {
        invalid = true;
        continue;
      }
      const merged = {
        ...existingMaterial,
        evidence: { ...existingMaterial.evidence, excerpts, targetIds },
        summaryEvidence,
      };
      seen.set(identity, merged);
      materials[materials.indexOf(existingMaterial)] = merged;
      continue;
    }
    seen.set(identity, material);
    materials.push(material);
  }
  const coverage =
    invalid || input.context?.truncated ? 'partial' : envelope.data.coverage;
  return { materials, coverage };
};
