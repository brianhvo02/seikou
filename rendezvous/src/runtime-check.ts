/**
 * Compile-time only (tsconfig.rendezvous.json, Workers types): the narrow interfaces the Worker and the
 * Durable Object are written against, so Node can run them in tests, must accept the real runtime objects.
 */
import type { RegistryState } from './code-registry';
import type { SignallingState } from './signalling';
import type worker from './index';
import type { Env } from './index';

type Assert<T extends true> = T;

/** Never used as a value: each entry fails the type check when a real Workers object stops fitting the narrow interface. */
export type RuntimeChecks = [
  Assert<DurableObjectState extends RegistryState ? true : false>,
  Assert<DurableObjectState extends SignallingState ? true : false>,
  Assert<{ CODE_REGISTRY: DurableObjectNamespace; SIGNALLING: DurableObjectNamespace } extends Env ? true : false>,
  Assert<typeof worker extends ExportedHandler<Env> ? true : false>,
];
