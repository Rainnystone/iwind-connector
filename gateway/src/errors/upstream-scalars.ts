const VENDOR_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface UpstreamLogScalars {
  readonly upstreamStatus: number | null;
  readonly upstreamErrorCode: string | null;
}

export function allowlistedUpstreamStatus(status: number | null | undefined): number | null {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function allowlistedUpstreamErrorCode(code: string | null | undefined): string | null {
  return typeof code === "string" && VENDOR_ERROR_CODE.test(code) ? code : null;
}
