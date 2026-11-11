import type { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export declare const jsonValueSchema: z.ZodType<JsonValue>;
