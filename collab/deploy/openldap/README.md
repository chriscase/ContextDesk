# OpenLDAP fixture (CI / local)

Synthetic directory for #885. Domain `example.test` only — no employer
hostnames. Passwords are fixture secrets, not production credentials.

```bash
# after the osixia/openldap container is up with LDAP_DOMAIN=example.test
ldapadd -x -H ldaps://127.0.0.1:636 \
  -D cn=admin,dc=example,dc=test \
  -w "$OPENLDAP_ADMIN_PASSWORD" \
  -o tls_reqcert=never \
  -f deploy/openldap/seed.ldif
```

App env for the fixture (verification disabled only with explicit dev mode):

```
COLLAB_LDAP_URL=ldaps://127.0.0.1:636
COLLAB_LDAP_DEV_MODE=1
COLLAB_LDAP_TLS_INSECURE=1
COLLAB_LDAP_USER_DN_TEMPLATE=uid={username},ou=people,dc=example,dc=test
COLLAB_LDAP_GROUP_SEARCH_BASE=ou=groups,dc=example,dc=test
COLLAB_GROUP_ROLE_MAP=cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin
```
