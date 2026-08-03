'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useActionState } from 'react'
import { saveNickname, type NicknameActionState } from './actions'

const initialState: NicknameActionState = { error: null }

export function OnboardingForm({ defaultNickname, prompt }: { defaultNickname: string; prompt: string }) {
  const [state, formAction, isPending] = useActionState(saveNickname, initialState)

  return (
    <form action={formAction} className="w-full space-y-4">
      <input name="prompt" type="hidden" value={prompt} />
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[#ededed]">昵称</span>
        <Input
          autoComplete="nickname"
          autoFocus
          className="h-10 rounded-lg border-white/14 bg-[#0a0a0a]! px-3 text-base! text-[#ededed] shadow-none focus-visible:border-white/50 focus-visible:ring-4 focus-visible:ring-white/20"
          defaultValue={defaultNickname}
          maxLength={64}
          name="nickname"
          required
        />
      </label>
      {state.error && <p className="text-sm text-red-400" role="alert">{state.error}</p>}
      <Button className="h-10 w-full rounded-lg bg-[#ededed] text-[#0a0a0a] hover:bg-white" disabled={isPending} type="submit">
        {isPending ? '正在创建…' : '创建工作区'}
      </Button>
    </form>
  )
}
