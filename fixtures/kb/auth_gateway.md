# Authentication gateway

Session tokens are validated in the **gateway middleware** before requests
reach application handlers.

## Session cookies

Cookies are httpOnly and bound to the request path `/api`.

## Related

See also billing for payment auth after session establish.
