'use client'

import { OrganizationSetup } from '@/components/organization-setup'
import {
  FeatureDialog,
  FeatureDialogBody,
  FeatureDialogContent,
  FeatureDialogDescription,
  FeatureDialogHeader,
  FeatureDialogTitle,
} from '@/components/ui/feature-dialog'
import { useT } from '@/lib/i18n/client'

export function OrganizationDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  return (
    <FeatureDialog onOpenChange={onOpenChange} open={open}>
      <FeatureDialogContent>
        <FeatureDialogHeader>
          <FeatureDialogTitle>{t('组织工作区')}</FeatureDialogTitle>
          <FeatureDialogDescription>{t('创建新组织，或使用邀请码加入已有组织。')}</FeatureDialogDescription>
        </FeatureDialogHeader>
        <FeatureDialogBody>
          <OrganizationSetup />
        </FeatureDialogBody>
      </FeatureDialogContent>
    </FeatureDialog>
  )
}
