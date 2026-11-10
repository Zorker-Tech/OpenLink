import { errorLogTag } from "../../../shared/errors/summary.ts";
import { reportHostDiagnostic } from "../../host-diagnostics.ts";

export function reportSlateLabelingFailure(stage: string, error: unknown): void {
  reportHostDiagnostic({ kind: "labeling_failed", stage, errorClass: errorLogTag(error) });
}
