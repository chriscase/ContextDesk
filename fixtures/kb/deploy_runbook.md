# Deploy runbook

## Production rollout

1. Tag a release.
2. Run CI green gate.
3. Deploy with `scripts/deploy.sh`.

## Rollback

Use the previous container image if health checks fail.
