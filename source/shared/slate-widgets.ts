/**
 * The widgets a message can carry.
 *
 * A widget is a choice offered to the user — a set of options, with the styles and the questions that go with them —
 * and it is read against a schema, so a message that carries a widget the platform cannot render is refused rather
 * than half-read.
 */
import { z } from "zod";

/** What each style is for, as the model is told when it offers a choice. */
export const widgetActionStyleSchema = z.enum(["default", "primary", "danger"]);

/** How the model is told what the value of an option is for. */
const VALUE_DESCRIPTION = "Text sent back to you when this option is picked. Defaults to the label. Make it read like something the user would naturally say in reply.";

/** How the model is told it may let the user type an answer of their own. */
const ALLOW_CUSTOM_DESCRIPTION = "When true, the user can type a custom free-text answer instead of choosing one of the options.";

/** How the model is told a question may be dropped once the user moves on. */
const DISMISS_ON_MOVE_ON_DESCRIPTION = "When true, this widget auto-dismisses (becomes inert, shows a muted Dismissed state) once the user sends a newer message without answering it. Omit/false to keep the question live and answerable indefinitely. Set true only for low-stakes questions that become moot if the user moves on; keep it off for real decisions you still need answered.";

export const choiceOptionSchema = z.object({
  label: z.string().trim().min(1),
  value: z.string().trim().min(1).optional().describe(VALUE_DESCRIPTION),
  description: z.string().trim().min(1).optional(),
  style: widgetActionStyleSchema.optional(),
});

export const slateWidgetSchema = z.object({
  prompt: z.string().trim().min(1),
  helpText: z.string().trim().min(1).optional(),
  options: z.array(choiceOptionSchema).min(1).max(6),
  allowCustom: z.boolean().optional().describe(ALLOW_CUSTOM_DESCRIPTION),
  dismissOnMoveOn: z.boolean().optional().describe(DISMISS_ON_MOVE_ON_DESCRIPTION),
});

export type SlateWidget = z.infer<typeof slateWidgetSchema>;

interface WidgetLike {
  readonly prompt?: unknown;
  readonly options?: unknown;
}

/** The options a widget carries, or none when what it carries is not a list of them. */
function optionsOf(widget: WidgetLike): readonly { readonly label?: unknown; readonly value?: unknown }[] {
  return Array.isArray(widget.options) ? (widget.options as { readonly label?: unknown; readonly value?: unknown }[]) : [];
}

/** A widget in one line: the question, and the labels it offers beside it. */
export function summarizeWidget(widget: WidgetLike): string {
  const prompt = typeof widget.prompt === "string" ? widget.prompt : "Question";
  const labels = optionsOf(widget)
    .map((option) => option.label)
    .join(" / ");
  return labels.length > 0 ? `${prompt} — ${labels}` : prompt;
}

/** The label an answer came from: the option whose value (or label) was sent, or the answer itself when none was. */
export function getWidgetAnswerLabel(widget: WidgetLike, answer: string): string {
  const match = optionsOf(widget).find((option) => (option.value ?? option.label) === answer);
  return (match?.label as string | undefined) ?? answer;
}
