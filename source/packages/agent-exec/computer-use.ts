/**
 * The operation behind computer use, and what its actions amount to when they are summarized.
 *
 * A computer-use call is a sequence of actions against a screen, and what a reader wants from it is not the sequence but its shape: how many clicks, how many keystrokes, how long it waited. That summary is what the platform reports about a call, so it is computed here from the actions themselves rather than inferred from a log. The settle delay beside it is the pause the platform allows between an action and the screenshot that proves it worked, which is a property of the screen rather than of the caller.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer
} from "./exec-serialization.ts";
import type { ComputerUseArgs, ComputerUseResult } from "../proto/generated/agent/v1/computer_use_tool_pb.ts";

export interface ComputerUseActionLike {
  readonly action: {
    readonly case:
      | "mouseMove"
      | "click"
      | "mouseDown"
      | "mouseUp"
      | "drag"
      | "scroll"
      | "type"
      | "key"
      | "wait"
      | "screenshot"
      | "cursorPosition"
      | undefined;
  };
}

export interface ComputerUseActionCounts {
  readonly mouse_move: number;
  readonly click: number;
  readonly mouse_down: number;
  readonly mouse_up: number;
  readonly drag: number;
  readonly scroll: number;
  readonly type: number;
  readonly key: number;
  readonly wait: number;
  readonly screenshot: number;
  readonly cursor_position: number;
}

export function summarizeComputerUseActions(
  actions: readonly ComputerUseActionLike[]
): { readonly actionCount: number; readonly actionCounts: ComputerUseActionCounts } {
  const actionCounts: Record<keyof ComputerUseActionCounts, number> = {
    mouse_move: 0,
    click: 0,
    mouse_down: 0,
    mouse_up: 0,
    drag: 0,
    scroll: 0,
    type: 0,
    key: 0,
    wait: 0,
    screenshot: 0,
    cursor_position: 0
  };
  for (const action of actions) {
    switch (action.action.case) {
      case "mouseMove": actionCounts.mouse_move += 1; break;
      case "click": actionCounts.click += 1; break;
      case "mouseDown": actionCounts.mouse_down += 1; break;
      case "mouseUp": actionCounts.mouse_up += 1; break;
      case "drag": actionCounts.drag += 1; break;
      case "scroll": actionCounts.scroll += 1; break;
      case "type": actionCounts.type += 1; break;
      case "key": actionCounts.key += 1; break;
      case "wait": actionCounts.wait += 1; break;
      case "screenshot": actionCounts.screenshot += 1; break;
      case "cursorPosition": actionCounts.cursor_position += 1; break;
      case undefined: break;
    }
  }
  return { actionCount: actions.length, actionCounts };
}

export const COMPUTER_USE_SCREENSHOT_SETTLE_DELAY_MS = 2_000;

export const computerUseExecutorResource = createResource<
  Executor<ComputerUseArgs, ComputerUseResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("computerUseArgs"),
    createClientDeserializer("computerUseResult")
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(
    new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("computerUseArgs"),
      createClientSerializer("computerUseResult")
    )
  )
);
