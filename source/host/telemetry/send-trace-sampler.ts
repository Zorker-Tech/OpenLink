/**
 * Whether a send is traced.
 *
 * The sampler is parent-based with a root that never records, so a send that arrives under a trace keeps it and
 * nothing starts a trace of its own.
 */

/** What a sampler decides: record this span, or do not. */
export const SampleDecision = {
  NOT_RECORD: 0,
  RECORD: 1,
  RECORD_AND_SAMPLED: 2,
} as const;

/** A decision to not record anything: the root this build starts every send under. */
function notRecorded(): { readonly decision: typeof SampleDecision.NOT_RECORD } {
  return { decision: SampleDecision.NOT_RECORD };
}

/** A sampler that never records, whatever it is asked. */
export class NeverRecords {
  shouldSample() {
    return notRecorded();
  }

  toString(): string {
    // The label a tracer records, which is the sampler's name as the tracing vocabulary has it.
    return "AlwaysOffSampler";
  }
}

/** A sampler that answers what the trace it arrived under answered, and starts nothing of its own. */
export class FollowsItsParent {
  constructor(readonly config: { root: NeverRecords }) {}

  shouldSample() {
    return this.config.root.shouldSample();
  }

  toString(): string {
    return `ParentBased{root=${this.config.root.toString()}}`;
  }
}

/** The sampler a send is traced through: parent-based, over a root that never records. */
export function sendTraceSampler(): FollowsItsParent {
  return new FollowsItsParent({ root: new NeverRecords() });
}
