import { useTranslation } from "react-i18next"
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import type { FailedDetectorBatch, ScanNotDone } from "@/lib/dedup-runner"

/**
 * What a finished duplicate scan says beside its groups: the detector
 * batches that failed, unreadable (#108) or erroring (#118), a check the
 * model did not do (#112), or, only when the model checked every page and
 * found nothing, that the wiki is clean.
 */
export function DuplicateScanNotices({
  groupCount,
  failedBatches,
  notDone,
}: {
  groupCount: number
  failedBatches: FailedDetectorBatch[]
  notDone?: ScanNotDone
}) {
  const { t } = useTranslation()
  return (
    <>
      {failedBatches.length > 0 && (
        <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            {t("settings.sections.maintenance.dedup.batchesFailed", {
              count: failedBatches.length,
              pages: failedBatches.reduce((sum, batch) => sum + batch.pages, 0),
              reason: failedBatches[0].reason,
              defaultValue:
                "{{count}} detector batches ({{pages}} pages) failed, so those pages were not checked: {{reason}}",
            })}
          </div>
        </div>
      )}

      {notDone && (
        <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            {notDone.reason === "embedding-coverage-low"
              ? t("settings.sections.maintenance.dedup.notDoneCoverageLow", {
                  pages: notDone.pages,
                  defaultValue:
                    "The duplicate scan was not done: too few of its {{pages}} pages could be embedded for the prefilter, and a wiki this large is not scanned without it. Check the embedding settings and scan again.",
                })
              : t("settings.sections.maintenance.dedup.notDoneNoPairs", {
                  pages: notDone.pages,
                  defaultValue:
                    "The duplicate scan was not done: the embedding prefilter found no candidate pairs among its {{pages}} pages, and a wiki this large is not scanned without them, so duplicates may remain.",
                })}
          </div>
        </div>
      )}

      {groupCount === 0 && failedBatches.length === 0 && !notDone && (
        <div className="flex items-start gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            {t("settings.sections.maintenance.dedup.noneFound", {
              defaultValue: "No duplicate groups found. The wiki is clean.",
            })}
          </div>
        </div>
      )}
    </>
  )
}
