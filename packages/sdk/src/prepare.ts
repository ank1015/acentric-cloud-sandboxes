import { SandboxError, type Provider } from '@acentric-sandboxes/contracts';
import type { SavedCredentials } from './types.ts';

/** The wire request: saved credentials filled in. */
export function prepare<R>(
  input: { readonly provider: Provider; readonly credentials?: unknown },
  saved: Partial<SavedCredentials>,
): R {
  const credentials = input.credentials ?? saved[input.provider];
  if (credentials === undefined) {
    throw new SandboxError(
      `No credentials for ${input.provider}: pass them on the request or the client.`,
      { kind: 'invalid_request', provider: input.provider },
    );
  }
  return { ...input, credentials } as R;
}

export function checkTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && !(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    throw new SandboxError('timeoutMs must be a positive integer.', { kind: 'invalid_request' });
  }
}

/** A signal that aborts on the caller's signal or after `timeoutMs`. */
export function callSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(new SandboxError('The call was cancelled.', { kind: 'cancelled' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new SandboxError(`The call timed out after ${timeoutMs} ms.`, { kind: 'timeout' }),
            ),
          timeoutMs,
        );
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
