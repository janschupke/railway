/**
 * Turns an OIDC failure into something safe to write to the deployment log.
 *
 * `openid-client` attaches context to `error.cause`, and that context is sometimes the
 * parsed token response — oauth4webapi throws
 * `UnsupportedOperationError("unsupported `token_type` value", { cause: { body: json } })`
 * where `json` holds a live `access_token` and `refresh_token`. Other branches put the
 * decoded id_token `claims` there. Railway retains stdout, so logging `cause` wholesale
 * writes credentials to storage that outlives the request.
 *
 * So this reads an allow-list and nothing else. It never touches `cause`, and never
 * stringifies an object it did not pick apart field by field — the two habits that let
 * a credential reach a log.
 */

/** OAuth error-response fields. Named in RFC 6749 §5.2; none of them are secret. */
function oauthDetail(error: object): string {
  const {
    error: code,
    error_description: description,
    status,
  } = error as Record<string, unknown>;

  const parts = [
    typeof code === "string" ? code : null,
    typeof status === "number" ? `HTTP ${status}` : null,
    typeof description === "string" ? description : null,
  ].filter(Boolean);

  return parts.join(" · ");
}

/**
 * Error codes an authorization server may put in `?error=`.
 *
 * RFC 6749 §4.1.2.1 and OIDC Core §3.1.2.6. Closed on purpose: the value arrives on a URL
 * anyone can construct, so it is attacker-controlled and unbounded, and it was being
 * written verbatim into a field an operator greps. Everything outside this list becomes
 * `provider_error`, which costs nothing — the landing page already renders any code it
 * does not recognise as the same generic sentence.
 */
const PROVIDER_ERROR_CODES = new Set([
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "account_selection_required",
  "consent_required",
  "invalid_request_uri",
  "invalid_request_object",
  "request_not_supported",
  "request_uri_not_supported",
  "registration_not_supported",
]);

/** The provider's `?error=`, reduced to a value with bounded cardinality. */
export function classifyProviderError(value: string): string {
  return PROVIDER_ERROR_CODES.has(value) ? value : "provider_error";
}

export function describeOidcFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    // A thrown primitive: its own string form is the whole value, so it is safe.
    return String(error);
  }

  const named = error instanceof Error ? `${error.name}: ${error.message}` : "";
  const detail = oauthDetail(error);

  return [named, detail].filter(Boolean).join(" — ") || "unknown OIDC failure";
}
