export const formatUserInitials = (name: string) => {
  const trimmedName = name.trim();
  const words = trimmedName.split(/\s+/).filter((word) => word.length > 0);
  // No words means no initials; callers that can show an email fall back first.
  if (words.length === 0) return '';
  const lastInitial = words.length > 1 ? words[words.length - 1].charAt(0) : '';
  return `${words[0].charAt(0)}${lastInitial}`.toUpperCase();
};
