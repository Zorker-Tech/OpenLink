/** Stable loop pressure thresholds and their sampling cadence. */
const PRESSURE_THRESHOLD_VALUES = {
  EventLoopDelayP95Ms: 50,
  EventLoopUtilization: 0.7,
} as const;

const PRESSURE_TRACKER_VALUES = {
  SampleIntervalMs: 250,
  EventLoopResolutionMs: 20,
} as const;

export const EventLoopPressureThresholdDefault = Object.assign({}, PRESSURE_THRESHOLD_VALUES, {
  50: "EventLoopDelayP95Ms",
  "0.7": "EventLoopUtilization",
}) as typeof PRESSURE_THRESHOLD_VALUES & {
  readonly "50": "EventLoopDelayP95Ms";
  readonly "0.7": "EventLoopUtilization";
};

export type EventLoopPressureThresholdDefault = 50 | 0.7;

export const EventLoopPressureTrackerDefault = Object.assign({}, PRESSURE_TRACKER_VALUES, {
  250: "SampleIntervalMs",
  20: "EventLoopResolutionMs",
}) as typeof PRESSURE_TRACKER_VALUES & {
  readonly "250": "SampleIntervalMs";
  readonly "20": "EventLoopResolutionMs";
};

export type EventLoopPressureTrackerDefault = 250 | 20;
