/** The methods a box's VNC connection answers to, and how one is recognized. */

/** The contract name a box's VNC connection is opened under. */
export const BOX_VNC_RPC_CONTRACT_NAME = "box-vnc";

/** The two argument shapes a VNC method takes: no arguments, or one object. */
type VncMethodArgs<Kind extends "none" | "object"> = { readonly args: Kind };

const acceptsNoArguments = (): VncMethodArgs<"none"> => ({ args: "none" });
const acceptsObjectArguments = (): VncMethodArgs<"object"> => ({ args: "object" });

/** The methods the contract answers to; each entry keeps its own argument shape. */
export const BOX_VNC_METHOD_TABLE = {
  readClipboard: acceptsNoArguments(),
  writeClipboard: acceptsObjectArguments(),
  reportUserPresence: acceptsObjectArguments(),
} as const;

export type BoxVncMethod = keyof typeof BOX_VNC_METHOD_TABLE;

export function isBoxVncMethod(value: string): value is BoxVncMethod {
  return Object.hasOwn(BOX_VNC_METHOD_TABLE, value);
}
