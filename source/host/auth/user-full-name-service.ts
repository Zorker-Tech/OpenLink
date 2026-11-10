import { parseJwtPayload } from "../../shared/node/slate-token.ts"
import {
  getAccountIdentityBackendUrl,
  readAccountName,
} from "../../adapters/interop/slate-backend/account-name-adapter.ts"
import { displayNameFrom, nonEmpty } from "./user-full-name-policy.ts"

export { displayNameFrom, nonEmpty } from "./user-full-name-policy.ts"

export const GET_ME_TIMEOUT_MS = 10_000

async function loadAccountDisplayName(
  accessToken: string,
  getMachineId: () => Promise<string>,
): Promise<string | undefined> {
  const accountName = await readAccountName({
    accessToken,
    getMachineId,
    timeoutMs: GET_ME_TIMEOUT_MS,
  })
  return nonEmpty(displayNameFrom({
    firstName: accountName.givenName,
    lastName: accountName.familyName,
  }))
}

export function createSlateUserFullNameResolver(options: {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>
  readonly peekAccessToken: () => string | null
  readonly getMachineId: () => Promise<string>
  readonly fetchFullName?: (accessToken: string) => Promise<string | undefined>
  readonly log: (message: string) => void
}) {
  const fetchFullName = options.fetchFullName ?? ((token: string) => loadAccountDisplayName(token, options.getMachineId))
  let cachedAccount: string | undefined
  let cachedName: string | undefined
  let pendingRead: { readonly account: string; readonly completion: Promise<void> } | undefined
  let readGeneration = 0

  const signedInAccount = (): string | undefined => {
    const token = options.peekAccessToken()
    return token == null ? undefined : parseJwtPayload(token)?.sub
  }

  const loadForAccount = async (account: string): Promise<void> => {
    try {
      const token = await options.getAccessToken({ backendUrl: getAccountIdentityBackendUrl() })
      if (parseJwtPayload(token)?.sub !== account) return

      const name = await fetchFullName(token)
      if (signedInAccount() !== account) return
      cachedAccount = account
      cachedName = name
    } catch (error) {
      options.log(`user full-name resolve failed: ${String(error)}`)
    }
  }

  return {
    getUserFullName: (): string | undefined =>
      cachedAccount !== undefined && cachedAccount === signedInAccount() ? cachedName : undefined,

    async refresh(): Promise<void> {
      const account = signedInAccount()
      if (account === undefined || cachedAccount === account) return

      let pending = pendingRead
      if (pending === undefined || pending.account !== account) {
        const generation = ++readGeneration
        const completion = loadForAccount(account).finally(() => {
          if (readGeneration === generation) pendingRead = undefined
        })
        pending = { account, completion }
        pendingRead = pending
      }
      await pending.completion
    },
  }
}
