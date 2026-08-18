#!/usr/bin/env bash
# Does your identity provider's token introspection (RFC 7662) return claims that the access
# token itself does not carry?
#
# That is the whole question. hal2 gates on `groups`, the access token does not carry it, and
# It matters because hal2's claim gate reads an identity claim such as `groups`, an access token
# audience-bound to the MCP endpoint (RFC 8707, which MCP requires clients to ask for) generally
# does not carry it, and a provider's userinfo endpoint may refuse such a token outright. If
# introspection fills that gap it is the standards-sanctioned source; if it does not, the claim
# has to come from the token itself. This answers which, and does not guess.
#
# Nothing here is printed that should not be: the secret is read from the environment and never
# echoed, and the token is shown only as its first characters.
set -euo pipefail

: "${ISSUER:?set ISSUER to your identity provider base URL}"
: "${CLIENT_ID:?set CLIENT_ID}"

usage() {
  cat <<'USAGE'
Usage — three steps, run in order:

  1. Print the URL to open in a browser (grants a token for your own user):
       ISSUER=… CLIENT_ID=… REDIRECT_URI=… RESOURCE=… ./introspect-check.sh authurl

  2. Paste back the `code` from the callback URL to get an access token:
       ISSUER=… CLIENT_ID=… CLIENT_SECRET=… REDIRECT_URI=… ./introspect-check.sh exchange <code> <verifier>

  3. Introspect that token and compare it against its own claims:
       ISSUER=… CLIENT_ID=… CLIENT_SECRET=… ./introspect-check.sh introspect <access-token>

Step 3 is the answer. Steps 1-2 exist only to get a real user token; if you already
have one (from Hermes, or a browser session), skip straight to step 3.
USAGE
}

case "${1:-}" in
authurl)
  : "${REDIRECT_URI:?set REDIRECT_URI to a callback registered on this client}"
  : "${RESOURCE:?set RESOURCE to your MCP endpoint URL, e.g. https://mcp.example.com/mcp}"
  RESOURCE_ENC=$(python3 -c 'import sys,urllib.parse as u; print(u.quote(sys.argv[1], safe=""))' "$RESOURCE")
  VERIFIER=$(head -c 64 /dev/urandom | base64 | tr -d '=+/' | cut -c1-64)
  # Providers reject a short `state` as too weak — Pocket ID wants at least 8 characters — and
  # the flow fails after the browser step, which is the most annoying place to lose it.
  STATE=$(head -c 24 /dev/urandom | base64 | tr -d '=+/' | cut -c1-24)
  CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
  echo "code_verifier (keep for step 2): $VERIFIER"
  echo
  echo "Open this, sign in, then copy the ?code= value from the callback URL:"
  echo
  echo "${ISSUER}/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=openid+profile+email+groups&resource=${RESOURCE_ENC}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=${STATE}"
  ;;

exchange)
  : "${CLIENT_SECRET:?set CLIENT_SECRET}"; : "${REDIRECT_URI:?set REDIRECT_URI}"
  CODE="${2:?pass the code}"; VERIFIER="${3:?pass the code_verifier from step 1}"
  curl -s --max-time 20 -u "${CLIENT_ID}:${CLIENT_SECRET}" \
    -d grant_type=authorization_code -d "code=${CODE}" \
    --data-urlencode "redirect_uri=${REDIRECT_URI}" -d "code_verifier=${VERIFIER}" \
    "${ISSUER}/api/oidc/token" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('access_token') or json.dumps(d,indent=2))"
  ;;

introspect)
  : "${CLIENT_SECRET:?set CLIENT_SECRET}"
  TOKEN="${2:?pass the access token}"
  echo "token: ${TOKEN:0:24}…"
  curl -s --max-time 20 -u "${CLIENT_ID}:${CLIENT_SECRET}" \
       -d "token=${TOKEN}" "${ISSUER}/api/oidc/introspect" \
  | TOKEN="$TOKEN" python3 -c "
import json, sys, os, base64

def payload(tok):
    try:
        p = tok.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4)))
    except Exception:
        return {}

intro = json.load(sys.stdin)
jwt   = payload(os.environ['TOKEN'])

print()
print('  introspection HTTP-svar:', 'active=' + str(intro.get('active')))
if not intro.get('active'):
    print('  (inaktiv token — hämta en färsk och kör om)')
    print('  hela svaret:', json.dumps(intro, indent=2, ensure_ascii=False))
    raise SystemExit(0)

extra   = sorted(set(intro) - set(jwt))
missing = sorted(set(jwt) - set(intro))
print()
print('  claims i access-tokenen :', ' '.join(sorted(jwt)) or '(inga)')
print('  claims i introspection  :', ' '.join(sorted(intro)) or '(inga)')
print()
print('  introspection TILLFÖR   :', ' '.join(extra) or 'INGENTING')
print('  finns bara i tokenen    :', ' '.join(missing) or '(inget)')
print()
for k in ('groups', 'email', 'name'):
    where = []
    if k in jwt:   where.append('token')
    if k in intro: where.append('introspection')
    print(f'  {k:8} -> ' + (', '.join(where) if where else 'SAKNAS HELT'))
print()
print('  SVAR:', 'introspection duger som identitetskälla'
      if 'groups' in intro else 'introspection löser INTE groups-problemet')
"
  ;;

*) usage ;;
esac
