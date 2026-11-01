import { createConnection, createServer, type Socket } from 'node:net';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  academicMessageSchema,
  academicRequestSchema,
  type AcademicAction,
  type AcademicEndpointSchema,
  type AcademicEventChannel,
  type AcademicMessageSchema,
} from './contracts';

type AcademicServer = {
  directory: string;
  endpoint: AcademicEndpointSchema;
  close: () => Promise<void>;
  publish: (channel: AcademicEventChannel, value: unknown) => void;
};

const frameLimit = 4 * 1024 * 1024;
const send = (socket: Socket, value: unknown) => {
  const frame = JSON.stringify(value) + '\n';
  if (
    Buffer.byteLength(frame) > frameLimit ||
    socket.writableLength > frameLimit
  ) {
    socket.destroy();
    return;
  }
  socket.write(frame);
};
const receive = (socket: Socket, onMessage: (value: unknown) => void) => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (data) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > frameLimit) {
      socket.destroy();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        onMessage(JSON.parse(frame));
      } catch {
        socket.destroy();
        return;
      }
    }
  });
};

export const createAcademicServer = async ({
  directory,
  actions,
}: {
  directory: string;
  actions: Map<string, AcademicAction>;
}): Promise<AcademicServer> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = path.join(directory, 'owner.json');
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(lock, 'utf8')) as {
      pid: number;
    };
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0)
      throw new Error('Invalid academic service owner.');
    try {
      process.kill(previous.pid, 0);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
      await rm(lock);
      return createAcademicServer({ directory, actions });
    }
    throw new Error('The academic service is already running.');
  }
  const name = createHash('sha256')
    .update(directory)
    .digest('hex')
    .slice(0, 24);
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\scholaros-${name}`
      : path.join(tmpdir(), `scholaros-${name}.sock`);
  const token = randomBytes(32).toString('hex');
  const endpoint: AcademicEndpointSchema = { version: 1, address, token };
  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      subscribers.delete(socket);
    });
    let busy = false;
    receive(socket, (value) => {
      if (busy) {
        socket.destroy();
        return;
      }
      const parsed = academicRequestSchema.safeParse(value);
      const id = parsed.success ? parsed.data.id : '';
      const candidate = parsed.success
        ? Buffer.from(parsed.data.token)
        : Buffer.alloc(0);
      const secret = Buffer.from(token);
      if (
        !parsed.success ||
        candidate.length !== secret.length ||
        !timingSafeEqual(candidate, secret)
      ) {
        send(socket, {
          kind: 'result',
          id,
          error: 'Unauthorized academic service request.',
        });
        socket.end();
        return;
      }
      const request = parsed.data;
      if (request.method === 'subscribe') {
        socket.setTimeout(0);
        subscribers.add(socket);
        send(socket, { kind: 'result', id, value: null });
        return;
      }
      busy = true;
      socket.setTimeout(0);
      void Promise.resolve()
        .then(() => {
          if (request.method === 'health') return { ready: actions.size > 0 };
          const action = actions.get(request.method);
          if (!action) throw new Error('Unsupported academic operation.');
          return action(request.input);
        })
        .then(
          (result) => send(socket, { kind: 'result', id, value: result }),
          (error: unknown) =>
            send(socket, {
              kind: 'result',
              id,
              error:
                error instanceof Error
                  ? error.message
                  : 'Academic operation failed.',
            }),
        )
        .finally(() => {
          busy = false;
        });
    });
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path.join(directory, 'endpoint.json'), { force: true });
    if (process.platform !== 'win32') await rm(address, { force: true });
    await rm(lock, { force: true });
  };
  try {
    if (process.platform !== 'win32') await rm(address, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') await chmod(address, 0o600);
    await writeFile(
      path.join(directory, 'endpoint.json'),
      JSON.stringify(endpoint),
      { mode: 0o600 },
    );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    directory,
    endpoint,
    close,
    publish: (channel: AcademicEventChannel, value: unknown) => {
      for (const socket of subscribers)
        send(socket, { kind: 'event', channel, value });
    },
  };
};

const connect = (
  endpoint: { version: number; address: string; token: string },
  method: string,
  input: unknown,
  onMessage: (message: AcademicMessageSchema) => void,
) => {
  const socket = createConnection(endpoint.address);
  const id = randomUUID();
  socket.once('connect', () =>
    send(socket, { ...endpoint, id, method, input }),
  );
  receive(socket, (value) => onMessage(academicMessageSchema.parse(value)));
  return socket;
};

export const academicRequest = (
  endpoint: { version: number; address: string; token: string },
  method: string,
  input?: unknown,
  timeoutMs = 30 * 60_000,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = connect(endpoint, method, input, (message) => {
      if (message.kind !== 'result') return;
      clearTimeout(timer);
      socket.end();
      if (message.error) reject(new Error(message.error));
      else resolve(message.value);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('The academic service request timed out.'));
    }, timeoutMs);
    socket.on('error', () => {
      clearTimeout(timer);
      reject(new Error('The academic service is unavailable.'));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      reject(new Error('The academic service disconnected.'));
    });
  });

export const subscribeAcademic = (
  endpoint: AcademicEndpointSchema,
  listener: (channel: AcademicEventChannel, value: unknown) => void,
  onClose: () => void,
): Promise<() => void> =>
  new Promise((resolve, reject) => {
    let authenticated = false;
    const socket = connect(endpoint, 'subscribe', undefined, (message) => {
      if (message.kind === 'event') listener(message.channel, message.value);
      else if (message.error) {
        reject(new Error(message.error));
        socket.destroy();
      } else {
        authenticated = true;
        clearTimeout(timer);
        resolve(() => {
          socket.removeListener('close', disconnected);
          socket.destroy();
        });
      }
    });
    const disconnected = () => {
      clearTimeout(timer);
      if (authenticated) onClose();
      else reject(new Error('The academic subscription disconnected.'));
    };
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => socket.destroy());
    socket.once('close', disconnected);
  });
