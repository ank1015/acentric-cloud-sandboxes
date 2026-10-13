import type { SandboxErrorData } from './errors.ts';

/** Gateway routes, relative to its base URL. All take and answer JSON. */
export const ROUTES = {
  /** POST a `StartRequest`; answers a `StartResponse`. */
  start: '/v1/executions/start',
  /** POST a `WaitRequest`; answers an `ExecutionResult`. */
  wait: '/v1/executions/wait',
  /** POST a `KillRequest`; answers an `ExecutionResult`. */
  kill: '/v1/executions/kill',
  /** POST a `ListRequest`; answers a `ListResponse`. */
  list: '/v1/executions/list',
  /** POST a `DeleteRequest`; answers a `DeleteResponse`. */
  delete: '/v1/executions/delete',
  /** POST a `DeleteAllRequest`; answers a `DeleteAllResponse`. */
  deleteAll: '/v1/executions/delete-all',
} as const;

/** Body of every unsuccessful gateway response. */
export interface ErrorResponse {
  readonly error: SandboxErrorData;
}
