/** Error with a message that is safe and useful to show to the user. */
export class AdsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdsError';
  }
}

const HINTS: Record<string, string> = {
  DEVELOPER_TOKEN_NOT_APPROVED:
    'This method needs Basic API access; the Google Cloud project has Explorer access. See docs/API_ACCESS.md.',
  CUSTOMER_NOT_ENABLED:
    'The Google Ads account is not enabled (setup or billing not finished, or account closed).',
  USER_PERMISSION_DENIED:
    'Permission denied for this account. Check GOOGLE_ADS_LOGIN_CUSTOMER_ID (the manager account).',
  ACTION_NOT_PERMITTED:
    'Action not permitted. If the message mentions test accounts, the Cloud project is still at Test access level.',
  CUSTOMER_NOT_FOUND: 'Customer ID not found or not accessible.',
  QUERY_ERROR: 'Invalid GAQL query.',
};

interface GoogleErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: Array<{ errors?: Array<{ errorCode?: Record<string, string>; message?: string }> }>;
  };
}

/** Converts a Google Ads REST error payload into an AdsError without leaking request data. */
export function mapGoogleAdsError(httpStatus: number, body: unknown): AdsError {
  const err = (body as GoogleErrorBody)?.error;
  const first = err?.details?.find((d) => d.errors?.length)?.errors?.[0];
  const codeValue = first?.errorCode ? Object.values(first.errorCode)[0] : undefined;
  const codeKey = first?.errorCode ? Object.keys(first.errorCode)[0] : undefined;
  const detail = (first?.message || err?.message || `HTTP ${httpStatus}`).slice(0, 300);

  if (/explorer access/i.test(detail)) {
    return new AdsError('BASIC_ACCESS_REQUIRED', `${HINTS.DEVELOPER_TOKEN_NOT_APPROVED} Google said: ${detail}`);
  }
  const code = codeValue || err?.status || `HTTP_${httpStatus}`;
  const hint = (codeValue && HINTS[codeValue]) || (codeKey === 'queryError' ? HINTS.QUERY_ERROR : undefined);
  return new AdsError(code, hint ? `${hint} Google said: ${detail}` : `Google Ads API error (${code}): ${detail}`);
}
