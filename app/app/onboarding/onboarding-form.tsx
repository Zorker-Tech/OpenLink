'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OrganizationSetup } from '@/components/organization-setup'
import { useT } from '@/lib/i18n/client'
import { useActionState } from 'react'
import { saveNickname, type NicknameActionState } from './actions'

const initialState: NicknameActionState = { error: null }

export function OnboardingForm({
  defaultNickname,
  prompt,
  step,
}: {
  defaultNickname: string
  prompt: string
  step: 'nickname' | 'organization'
}) {
  const [state, formAction, isPending] = useActionState(saveNickname, initialState)
  const t = useT()

  if (step === 'organization') {
    return <OrganizationSetup prompt={prompt} showSkip />
  }

  return (
    <form action={formAction} className="w-full space-y-4">
      <input name="prompt" type="hidden" value={prompt} />
      <label className="block space-y-2">
        <span className="text-sm font-medium text-foreground">{t('昵称')}</span>
        <Input
          autoComplete="nickname"
          autoFocus
          className="h-10 rounded-lg border-input bg-background px-3 text-base! text-foreground shadow-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
          defaultValue={defaultNickname}
          maxLength={64}
          name="nickname"
          required
        />
      </label>
      {state.error && <p className="text-sm text-destructive" role="alert">{state.error}</p>}
      <Button className="h-10 w-full rounded-lg" disabled={isPending} type="submit">
        {isPending ? t('正在保存…') : t('继续')}
      </Button>
    </form>
  )
}
