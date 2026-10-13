import { type Provider } from '@acentric-sandboxes/contracts';
import type { ProviderAdapter } from './adapter.ts';
import * as operations from './operations.ts';
import { invalid } from './parse.ts';
import { blaxel } from './providers/blaxel.ts';
import { daytona } from './providers/daytona.ts';
import { e2b } from './providers/e2b.ts';
import { tensorlake } from './providers/tensorlake.ts';

/** Every implemented provider. */
export const PROVIDERS: { readonly [P in Provider]?: ProviderAdapter<P> } = {
  e2b,
  daytona,
  blaxel,
  tensorlake,
};

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
}

export function adapterFor(provider: unknown): ProviderAdapter {
  if (!isProvider(provider)) {
    throw invalid(
      `provider must be one of ${Object.keys(PROVIDERS).join(', ')}; got ${JSON.stringify(provider)}.`,
    );
  }
  return PROVIDERS[provider] as ProviderAdapter;
}

const registry: operations.Operations = { adapterFor };

export const start = (...args: Tail<typeof operations.start>) =>
  operations.start(registry, ...args);
export const wait = (...args: Tail<typeof operations.wait>) => operations.wait(registry, ...args);
export const kill = (...args: Tail<typeof operations.kill>) => operations.kill(registry, ...args);
export const list = (...args: Tail<typeof operations.list>) => operations.list(registry, ...args);
export const deleteExecution = (...args: Tail<typeof operations.deleteExecution>) =>
  operations.deleteExecution(registry, ...args);
export const deleteAll = (...args: Tail<typeof operations.deleteAll>) =>
  operations.deleteAll(registry, ...args);

type Tail<F> = F extends (first: never, ...rest: infer R) => unknown ? R : never;
