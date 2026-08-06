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

export function OrganizationDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <FeatureDialog onOpenChange={onOpenChange} open={open}>
      <FeatureDialogContent>
        <FeatureDialogHeader>
          <FeatureDialogTitle>组织工作区</FeatureDialogTitle>
          <FeatureDialogDescription>创建新组织，或使用邀请码加入已有组织。</FeatureDialogDescription>
        </FeatureDialogHeader>
        <FeatureDialogBody>
          <OrganizationSetup />
        </FeatureDialogBody>
      </FeatureDialogContent>
    </FeatureDialog>
  )
}
