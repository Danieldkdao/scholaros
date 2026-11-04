import { app, protocol } from 'electron';

export const activitySchemePrivileges = {
  scheme: 'scholar-activity',
  privileges: {
    standard: true,
    secure: true,
    bypassCSP: false,
    allowServiceWorkers: false,
    supportFetchAPI: false,
    corsEnabled: false,
    stream: false,
    codeCache: false,
    allowExtensions: false,
  },
} satisfies Electron.CustomScheme;

type ActivitySchemeRegistrarDependencies = {
  isReady: () => boolean;
  registerSchemesAsPrivileged: (
    schemes: Parameters<typeof protocol.registerSchemesAsPrivileged>[0],
  ) => void;
};

export const createActivitySchemeRegistrar = ({
  isReady,
  registerSchemesAsPrivileged,
}: ActivitySchemeRegistrarDependencies) => {
  let registered = false;

  return () => {
    if (isReady())
      throw new Error(
        'The activity protocol must be registered before app ready.',
      );
    if (registered) return;

    registerSchemesAsPrivileged([activitySchemePrivileges]);
    registered = true;
  };
};

let activitySchemeRegistered = false;

/** Compose with the app registrar when another scheme shares Electron's one-shot registration. */
export const registerActivitySchemeBeforeReady = (
  registerSchemesAsPrivileged: ActivitySchemeRegistrarDependencies['registerSchemesAsPrivileged'] = (
    schemes,
  ) => protocol.registerSchemesAsPrivileged(schemes),
) => {
  if (app.isReady())
    throw new Error(
      'The activity protocol must be registered before app ready.',
    );
  if (activitySchemeRegistered) return;

  registerSchemesAsPrivileged([activitySchemePrivileges]);
  activitySchemeRegistered = true;
};

export const isActivitySchemeRegistered = () => activitySchemeRegistered;
