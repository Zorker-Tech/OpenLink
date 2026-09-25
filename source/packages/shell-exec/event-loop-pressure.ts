/**
 * The two thresholds that decide when the event loop is under pressure, and how it is measured.
 *
 * A shell that streams a great deal of output can starve the process that is reading it, so the platform
 * watches the loop it runs on: a high 95th-percentile delay and a high utilization both mean the loop is
 * busy enough that streaming should back off. The sampling interval and the resolution are separate because
 * a delay percentile is only as meaningful as the resolution it was sampled at.
 */

export enum EventLoopPressureThresholdDefault { EventLoopDelayP95Ms = 50, EventLoopUtilization = 0.7 }
export enum EventLoopPressureTrackerDefault { SampleIntervalMs = 250, EventLoopResolutionMs = 20 }
