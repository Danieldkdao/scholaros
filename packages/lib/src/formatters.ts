export const formatUserInitials = (name: string) => {
  const trimmedName = name.trim();
  const words = trimmedName.split(/\s+/).filter((word) => word.length > 0);
  const lastInitial = words.length > 1 ? words[words.length - 1].charAt(0) : '';
  return `${words[0].charAt(0)}${lastInitial}`.toUpperCase();
};
