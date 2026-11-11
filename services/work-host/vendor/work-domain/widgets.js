import { z } from "zod";

export const slateWidgetSchema = z.object({
  prompt: z.string(),
  helpText: z.string().optional(),
  options: z.array(z.object({
    label: z.string(),
    value: z.string().optional(),
    description: z.string().optional(),
    style: z.string().optional(),
  })).optional(),
  allowCustom: z.boolean().optional(),
  dismissOnMoveOn: z.boolean().optional(),
}).passthrough();

export function summarizeWidget(widget) {
  const prompt = typeof widget?.prompt === "string" ? widget.prompt.trim() : "";
  return prompt.length > 0 ? prompt : "Question";
}
