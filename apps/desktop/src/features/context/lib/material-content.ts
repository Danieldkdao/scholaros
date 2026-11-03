import { createHash } from 'node:crypto';

export type MaterialPassage = {
  ordinal: number;
  heading: string | null;
  locator: string | null;
  text: string;
  sourceUrl: string;
};

export type MaterialContent = {
  hash: string;
  normalizedText: string;
  passages: MaterialPassage[];
};

type MaterialContentInput = {
  sourceUrl: string;
  text: string;
  pageLocators?: boolean;
  maxChars?: number;
  overlapChars?: number;
};

const removeUnsupportedControls = (text: string) =>
  Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x08 ||
      code === 0x0b ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
      ? ''
      : character;
  }).join('');

const normalizeSourceText = (text: string) =>
  text
    .split('\f')
    .map((page) =>
      removeUnsupportedControls(page)
        .replace(/\r\n?/g, '\n')
        .replace(/[\t ]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    )
    .join('\f');

const paragraphChunks = (
  text: string,
  maxChars: number,
  overlapChars: number,
) => {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const proposedEnd = Math.min(start + maxChars, text.length);
    let end = proposedEnd;
    if (proposedEnd < text.length) {
      const paragraphBreak = text.lastIndexOf('\n\n', proposedEnd);
      const lineBreak = text.lastIndexOf('\n', proposedEnd);
      const wordBreak = Math.max(
        text.lastIndexOf(' ', proposedEnd),
        text.lastIndexOf('\t', proposedEnd),
      );
      const candidate = [paragraphBreak, lineBreak, wordBreak]
        .filter((position) => position > start + Math.floor(maxChars / 2))
        .sort((left, right) => right - left)[0];
      if (candidate !== undefined) end = candidate;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    let nextStart = Math.max(start + 1, end - overlapChars);
    const nextWordBreak = text.indexOf(' ', nextStart);
    if (nextWordBreak >= 0 && nextWordBreak < end)
      nextStart = nextWordBreak + 1;
    start = nextStart;
  }
  return chunks;
};

const sectionsFromPage = (text: string, locator: string | null) => {
  const sections: Array<{
    heading: string | null;
    locator: string | null;
    text: string;
  }> = [];
  let heading: string | null = null;
  let paragraph: string[] = [];
  let body: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) body.push(paragraph.join('\n').trim());
    paragraph = [];
  };
  const flushSection = () => {
    flushParagraph();
    const sectionText = body.filter(Boolean).join('\n\n');
    if (sectionText) sections.push({ heading, locator, text: sectionText });
    body = [];
  };
  for (const line of text.split('\n')) {
    const markdownHeading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (markdownHeading) {
      flushSection();
      heading = markdownHeading[1]!.trim();
    } else if (!line.trim()) flushParagraph();
    else paragraph.push(line.trim());
  }
  flushSection();
  return sections;
};

export const buildMaterialContent = ({
  sourceUrl,
  text,
  pageLocators = false,
  maxChars = 4000,
  overlapChars = 250,
}: MaterialContentInput): MaterialContent => {
  const normalizedText = normalizeSourceText(text);
  const safeMaxChars = Math.max(100, Math.min(Math.floor(maxChars), 4000));
  const safeOverlapChars = Math.max(
    0,
    Math.min(Math.floor(overlapChars), safeMaxChars - 1),
  );
  const pages = normalizedText.split('\f');
  const passages: MaterialPassage[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    const pageLocator =
      pageLocators || pages.length > 1 ? `Page ${pageIndex + 1}` : null;
    for (const section of sectionsFromPage(page, pageLocator))
      for (const passageText of paragraphChunks(
        section.text,
        safeMaxChars,
        safeOverlapChars,
      ))
        passages.push({
          ordinal: passages.length,
          heading: section.heading,
          locator: section.locator,
          text: passageText,
          sourceUrl,
        });
  }
  return {
    hash: createHash('sha256').update(normalizedText).digest('hex'),
    normalizedText,
    passages,
  };
};
