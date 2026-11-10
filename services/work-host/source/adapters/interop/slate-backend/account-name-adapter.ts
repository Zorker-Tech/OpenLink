import type { MethodInfoUnary } from "@bufbuild/protobuf"
import {
  DashboardService,
} from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import {
  GetMeRequest,
  type GetMeResponse,
} from "../proto/generated/aiserver/v1/dashboard_pb.ts"
import {
  createSlateBackendClient,
  getSlateInferenceBackendUrl,
} from "./slate-backend-client.ts"

export interface AccountNameParts {
  readonly givenName: string | undefined
  readonly familyName: string | undefined
}

export interface GetMeClient {
  getMe(
    request: GetMeRequest,
    options: { readonly timeoutMs: number },
  ): Promise<Pick<GetMeResponse, "firstName" | "lastName">>
}

export function getAccountIdentityBackendUrl(): string {
  return getSlateInferenceBackendUrl()
}

export async function readAccountName(options: {
  readonly accessToken: string
  readonly getMachineId: () => Promise<string>
  readonly timeoutMs: number
  readonly createClient?: (input: {
    readonly accessToken: string
    readonly getMachineId: () => Promise<string>
  }) => GetMeClient
}): Promise<AccountNameParts> {
  const client = options.createClient?.({
    accessToken: options.accessToken,
    getMachineId: options.getMachineId,
  }) ?? createGetMeClient(options.accessToken, options.getMachineId)
  const response = await client.getMe(new GetMeRequest({}), { timeoutMs: options.timeoutMs })
  return { givenName: response.firstName, familyName: response.lastName }
}

function createGetMeClient(accessToken: string, getMachineId: () => Promise<string>): GetMeClient {
  const service = DashboardService as typeof DashboardService & {
    readonly methods: typeof DashboardService.methods & {
      readonly getMe: MethodInfoUnary<GetMeRequest, GetMeResponse>
    }
  }
  return createSlateBackendClient(service, {
    getAccessToken: async () => accessToken,
    getMachineId,
  })
}
