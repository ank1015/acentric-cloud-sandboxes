import { ROUTES } from '@acentric-sandboxes/contracts';
import {
  adapterFor,
  deleteAll,
  deleteExecution,
  kill,
  list,
  parseDelete,
  parseDeleteAll,
  parseKill,
  parseList,
  parseStart,
  parseWait,
  start,
  wait,
  type CallOptions,
} from '@acentric-sandboxes/providers';
import { errorResponse, HttpError, json, preflight, readJson } from './http.ts';

type Handler = (body: unknown, options: CallOptions) => Promise<unknown>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  [ROUTES.start]: (body, options) => start(parseStart(body, adapterFor), options),
  [ROUTES.wait]: (body, options) => wait(parseWait(body, adapterFor), options),
  [ROUTES.kill]: (body, options) => kill(parseKill(body, adapterFor), options),
  [ROUTES.list]: (body, options) => list(parseList(body, adapterFor), options),
  [ROUTES.delete]: (body, options) => deleteExecution(parseDelete(body, adapterFor), options),
  [ROUTES.deleteAll]: (body, options) => deleteAll(parseDeleteAll(body, adapterFor), options),
};

/** Stateless: nothing is stored, and request bodies (credentials, code) are never logged. */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      const handler = HANDLERS[pathname];
      if (!handler) throw new HttpError(404, `No route for ${pathname}.`);
      if (request.method === 'OPTIONS') return preflight('POST');
      if (request.method !== 'POST') {
        throw new HttpError(405, `${request.method} is not allowed; use POST.`, {
          allow: 'POST, OPTIONS',
        });
      }
      return json(await handler(await readJson(request), { signal: request.signal }));
    } catch (error) {
      return errorResponse(error);
    }
  },
};
