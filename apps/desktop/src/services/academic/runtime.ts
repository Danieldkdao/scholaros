import { app } from 'electron';
import path from 'node:path';
import { createAcademicServer } from './transport';
import type { AcademicAction } from './contracts';

export const runAcademicService = async () => {
  const actions = new Map<string, AcademicAction>();
  const server = await createAcademicServer({
    directory: path.join(app.getPath('userData'), 'academic-service'),
    actions,
  });
  app.dock?.hide();
  try {
    const { registerAcademicActions } =
      await import('../../features/onboarding/services/ipc');
    registerAcademicActions({
      register: (method, action) => actions.set(method, action),
      publish: server.publish,
    });
    actions.set('shutdown', () => {
      setTimeout(() => app.quit(), 20);
    });
    // The existing scheduler is restored from saved consent even without a window.
    const restore = async () => {
      const user = await actions.get('getCurrentUser')?.(undefined);
      if (user) await actions.get('getState')?.(undefined);
    };
    await restore().catch(() => undefined);
    const timer = setInterval(() => {
      void restore().catch(() => undefined);
    }, 30_000);
    let closed = false;
    app.on('will-quit', (event) => {
      if (closed) return;
      event.preventDefault();
      closed = true;
      clearInterval(timer);
      void server.close().finally(() => app.quit());
    });
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
};
