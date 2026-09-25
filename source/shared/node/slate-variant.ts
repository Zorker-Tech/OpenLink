/**
 * Which build of the platform this is.
 *
 * A packaged build is one the user installed, and of those a lab build is the one used to try things out; anything else
 * is a development build, which is what an unpackaged run is.
 */
export type SlateVariant = "slate-dev" | "slate-lab" | "slate";

export function isSlatePackaged(): boolean { return process.env.SLATE_PACKAGED === "1"; }
export function isSlateLabBuild(): boolean { return process.env.SLATE_LAB === "1"; }
export function getSlateVariant(): SlateVariant {
  return !isSlatePackaged() ? "slate-dev" : isSlateLabBuild() ? "slate-lab" : "slate";
}

