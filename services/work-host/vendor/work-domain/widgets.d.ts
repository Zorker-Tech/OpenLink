import type { z } from "zod";

export declare const slateWidgetSchema: z.ZodType<Record<string, unknown>>;
export declare function summarizeWidget(widget: unknown): string;
