import type { Provider } from '@acentric-sandboxes/contracts';
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
} from '@acentric-sandboxes/providers';
import { callSignal, checkTimeout, prepare } from './prepare.ts';
import type { CallOptions, ExecutionClient, SavedCredentials } from './types.ts';

export * from './index.ts';

export interface DirectClientOptions<K extends Provider = never> {
  /** Credentials per provider. */
  readonly credentials?: SavedCredentials<K>;
  /** A `fetch` to use instead of the global one. */
  readonly fetch?: typeof fetch;
  /** Limit for each call. */
  readonly timeoutMs?: number;
}

/**
 * Calls the sandbox providers directly, with the same adapters and checks the
 * gateway runs: no extra hop, and keys never leave the process. Bundles every
 * adapter.
 */
export function createDirectClient<K extends Provider = never>(
  options: DirectClientOptions<K> = {},
): ExecutionClient<K> {
  const saved: Partial<SavedCredentials> = options.credentials ?? {};
  checkTimeout(options.timeoutMs);

  function operation<R>(
    parse: (value: unknown, adapters: typeof adapterFor) => R,
    run: (request: R, call: { signal: AbortSignal; fetch?: typeof fetch }) => Promise<unknown>,
  ) {
    return async (
      input: { readonly provider: Provider; readonly credentials?: unknown },
      call: CallOptions = {},
    ): Promise<never> => {
      const request = parse(prepare(input, saved), adapterFor);
      const timeoutMs = call.timeoutMs ?? options.timeoutMs;
      checkTimeout(timeoutMs);
      const { signal, done } = callSignal(call.signal, timeoutMs);
      try {
        return (await run(request, {
          signal,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })) as never;
      } catch (error) {
        throw signal.aborted ? signal.reason : error;
      } finally {
        done();
      }
    };
  }

  return {
    start: operation(parseStart, start),
    wait: operation(parseWait, wait),
    kill: operation(parseKill, kill),
    list: operation(parseList, list),
    delete: operation(parseDelete, deleteExecution),
    deleteAll: operation(parseDeleteAll, deleteAll),
  };
}
