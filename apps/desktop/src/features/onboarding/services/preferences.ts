import { app } from 'electron';
import { errorMessage } from '../../../lib/error-message';
import type { LaunchAtLoginPreference } from '../types';

export const getLaunchAtLoginState = (
  requested: boolean,
): LaunchAtLoginPreference => {
  let actual = false;
  try {
    actual = app.getLoginItemSettings().openAtLogin === true;
  } catch (error) {
    return {
      requested,
      applied: false,
      message: errorMessage(
        error,
        'This computer could not report its login items.',
      ),
    };
  }
  if (actual === requested) return { requested, applied: true, message: null };
  return {
    requested,
    applied: false,
    message: requested
      ? 'This computer did not add ScholarOS to login items.'
      : 'This computer still starts ScholarOS at login.',
  };
};

export const applyLaunchAtLogin = (
  openAtLogin: boolean,
): LaunchAtLoginPreference => {
  try {
    app.setLoginItemSettings({ openAtLogin });
  } catch (error) {
    return {
      requested: openAtLogin,
      applied: false,
      message: errorMessage(
        error,
        'This computer blocked launch at login; check its login items.',
      ),
    };
  }
  return getLaunchAtLoginState(openAtLogin);
};
