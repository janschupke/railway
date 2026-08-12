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

export function describeOidcFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    // A thrown primitive: its own string form is the whole value, so it is safe.
    return String(error);
  }

  const named = error instanceof Error ? `${error.name}: ${error.message}` : "";
  const detail = oauthDetail(error);

  return [named, detail].filter(Boolean).join(" — ") || "unknown OIDC failure";
}
