import type { BlaxelSpec } from './providers/blaxel.ts';
import type { DaytonaSpec } from './providers/daytona.ts';
import type { E2bSpec } from './providers/e2b.ts';
import type { TensorlakeSpec } from './providers/tensorlake.ts';

/** What a provider contributes to the types. Every entry in `Providers` satisfies it. */
export interface ProviderSpec {
  /** The caller's credentials for this provider. */
  readonly credentials: object;
  /**
   * The provider's own references to a started execution, kept in its
   * handle: process IDs, names, session IDs. Never secrets.
   */
  readonly native: object;
}

/**
 * Every provider, keyed by ID. Each provider adds its entry here when it is
 * implemented, with types written from the provider's API reference.
 */
export interface Providers {
  readonly e2b: E2bSpec;
  readonly daytona: DaytonaSpec;
  readonly blaxel: BlaxelSpec;
  readonly tensorlake: TensorlakeSpec;
}

/** Fails to compile when a registered provider does not satisfy `ProviderSpec`. */
type CheckProviders<T extends { readonly [P in keyof Providers]: ProviderSpec }> = T;
export type RegisteredProviders = CheckProviders<Providers>;

export type Provider = keyof Providers & string;

type Spec<P extends Provider> = Providers[P] extends ProviderSpec ? Providers[P] : never;

export type Credentials<P extends Provider> = Spec<P>['credentials'];
export type NativeExecution<P extends Provider> = Spec<P>['native'];
