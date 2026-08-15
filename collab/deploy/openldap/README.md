# OpenLDAP fixture (CI / local)

Synthetic directory for #885. Domain `example.test` only — no employer
hostnames. Passwords are fixture secrets, not production credentials.

```bash
# after the osixia/openldap container is up with LDAP_DOMAIN=example.test
LDAPTLS_REQCERT=never ldapadd -x -H ldap://127.0.0.1:389 -ZZ \
  -D cn=admin,dc=example,dc=test \
  -w "$OPENLDAP_ADMIN_PASSWORD" \
  -f deploy/openldap/seed.ldif
```

App env for the fixture (verification disabled only with explicit dev mode).
Hosted CI seeds and binds with StartTLS on 389. Node 22 cannot complete
LDAPS to the osixia self-signed cert. StartTLS is encrypted and is the
#885-allowed alternative to `ldaps://`.

```
COLLAB_LDAP_URL=ldap://127.0.0.1:389
COLLAB_LDAP_STARTTLS=1
COLLAB_LDAP_DEV_MODE=1
COLLAB_LDAP_TLS_INSECURE=1
COLLAB_LDAP_USER_DN_TEMPLATE=uid={username},ou=people,dc=example,dc=test
COLLAB_LDAP_GROUP_SEARCH_BASE=ou=groups,dc=example,dc=test
# osixia hides ou=groups from a user bind (LDAP 0x20). Service-bind reads groups
# after the user password bind succeeds.
COLLAB_LDAP_BIND_DN=cn=admin,dc=example,dc=test
# COLLAB_LDAP_BIND_PASSWORD=replace-from-secret-store
COLLAB_GROUP_ROLE_MAP=cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin
```
