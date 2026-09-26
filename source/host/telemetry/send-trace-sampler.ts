/**
 * Whether a send is traced.
 *
 * The sampler is parent-based with a root that never records, so a send that arrives under a trace keeps it and
 * nothing starts a trace of its own.
 */
export const SamplingDecision = {
  NOT_RECORD: 0,
  RECORD: 1,
  RECORD_AND_SAMPLED: 2,
} as const;
export class AlwaysOffSampler {
  shouldSample() {
    return { decision: SamplingDecision.NOT_RECORD };
  }
  toString(): string {
    return "AlwaysOffSampler";
  }
}
export class ParentBasedSampler {
  constructor(readonly config: { root: AlwaysOffSampler }) {}
  shouldSample() {
    return this.config.root.shouldSample();
  }
  toString(): string {
    return `ParentBased{root=${this.config.root.toString()}}`;
  }
}
export function createSendTraceSampler(): ParentBasedSampler {
  return new ParentBasedSampler({ root: new AlwaysOffSampler() });
}
