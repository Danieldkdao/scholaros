export type ComposedAgentNotes = { notes: string; omitted: boolean };

export const composeAgentNotes = (
  host: string,
  connectionNotes: string | null,
  generalNotes: string,
): ComposedAgentNotes => {
  const specific = connectionNotes?.trim()
    ? `${host}: ${connectionNotes.trim()}`
    : '';
  const general = generalNotes.trim();
  const prefix = `${specific ? '\n' : ''}General: `;
  if (!general)
    return { notes: specific.slice(0, 2000), omitted: specific.length > 2000 };
  const remaining = 2000 - specific.length - prefix.length;
  if (remaining < 1) return { notes: specific.slice(0, 2000), omitted: true };
  if (general.length <= remaining)
    return { notes: `${specific}${prefix}${general}`, omitted: false };
  const fragment = general.slice(0, remaining);
  const wholeWords = fragment.replace(/\s+\S*$/, '').trimEnd();
  return {
    notes: wholeWords ? `${specific}${prefix}${wholeWords}` : specific,
    omitted: true,
  };
};
