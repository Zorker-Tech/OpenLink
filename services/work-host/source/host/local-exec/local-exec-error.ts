const LocalExecErrorType = class SlateLocalExecError extends Error {};

export const SlateLocalExecError = LocalExecErrorType;
export type SlateLocalExecError = InstanceType<typeof LocalExecErrorType>;

