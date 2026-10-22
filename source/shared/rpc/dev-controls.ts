/** The methods the development controls answer to, and how one is recognized. */
export const DEV_CONTROLS_RPC_CONTRACT_NAME = "dev-controls";

/** The methods that take no argument at all; every other method is called with an object. */
const WITHOUT_ARGUMENTS: readonly string[] = [
  "restartElectron",
  "reloadWindow",
  "restartOnboarding",
  "skipOnboarding",
  "themeStatus",
  "boxStatus",
  "boxHealth",
  "upgradeHost",
  "pokeHostUpgrade",
  "rebuildBox",
  "tailLogs",
  "startBox",
  "teardownBox",
  "nukeBox",
  "openDesktop",
  "boxStoreStatus",
  "boxStoreSnapshotNow",
  "boxStoreLogs",
  "boxStoreRecreateFresh",
  "boxStoreClear",
  "attachProdBoxStatus",
  "gatewayOfflineStatus",
  "onePasswordCliStatus",
  "prepareOnePasswordCli",
  "cancelOnePasswordCliPrepare",
  "onePasswordAccounts",
  "onePasswordVaults",
  "onePasswordFindVault",
  "onePasswordSyntheticProvisioning",
];

/** Every method of the surface, in the order the table names them. */
const METHOD_NAMES = [
  "restartElectron",
  "reloadWindow",
  "restartOnboarding",
  "skipOnboarding",
  "themeStatus",
  "setThemePreference",
  "boxStatus",
  "boxHealth",
  "upgradeHost",
  "pokeHostUpgrade",
  "rebuildBox",
  "tailLogs",
  "startBox",
  "teardownBox",
  "nukeBox",
  "openDesktop",
  "boxStoreStatus",
  "boxStoreSnapshotNow",
  "boxStoreLogs",
  "boxStoreRecreateFresh",
  "boxStoreClear",
  "attachProdBoxStatus",
  "setAttachProdBoxEnabled",
  "setWidgetGallery",
  "gatewayOfflineStatus",
  "setGatewayOffline",
  "onePasswordCliStatus",
  "prepareOnePasswordCli",
  "cancelOnePasswordCliPrepare",
  "onePasswordAccounts",
  "onePasswordVaults",
  "onePasswordFindVault",
  "onePasswordSyntheticProvisioning",
] as const;

type DevControlsMethodTable = Readonly<Record<(typeof METHOD_NAMES)[number], { readonly args: "object" | "none" }>>;

const WITHOUT_ARGUMENTS_SET: ReadonlySet<string> = new Set(WITHOUT_ARGUMENTS);

/** The methods, each saying whether it is called with an object or with nothing. */
export const DEV_CONTROLS_METHOD_TABLE: DevControlsMethodTable = Object.fromEntries(
  METHOD_NAMES.map((method) => [method, { args: WITHOUT_ARGUMENTS_SET.has(method) ? "none" : "object" }]),
) as DevControlsMethodTable;

export type DevControlsMethod = keyof typeof DEV_CONTROLS_METHOD_TABLE;

export function isDevControlsMethod(value: string): value is DevControlsMethod {
  return Object.hasOwn(DEV_CONTROLS_METHOD_TABLE, value);
}
