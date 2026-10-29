type SignOutDependencies = {
  signOut: () => Promise<void>;
  clearRendererState: () => void;
  navigateToAuth: () => Promise<void>;
};

// The main process cancels missions, clears local auth, and closes its browser
// before this resolves; the renderer only owns its own state and navigation.
export const exitAndSignOut = async ({
  signOut,
  clearRendererState,
  navigateToAuth,
}: SignOutDependencies) => {
  await signOut();
  clearRendererState();
  await navigateToAuth();
};
