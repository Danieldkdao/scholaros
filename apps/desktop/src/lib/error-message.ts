const ipcErrorPrefix = /^Error invoking remote method '[^']+': (?:Error: )?/;

export const errorMessage = (error: unknown, fallback: string) => {
  if (!(error instanceof Error) || !error.message) return fallback;
  return error.message.replace(ipcErrorPrefix, '') || fallback;
};
