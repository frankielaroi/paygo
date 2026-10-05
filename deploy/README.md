# Deployment

The PayGo API runs on a single EC2 instance in `eu-north-1`, as two containers: the
app and a Caddy TLS proxy in front of it.

| | |
| --- | --- |
| Instance | `i-0220b4264b42d3958` (t3.micro, Amazon Linux 2023) |
| Address | `13.61.227.223` (Elastic IP `eipalloc-07493751f24a603af`) |
| API | `https://13.61.227.223` |
| Device port | `13.61.227.223:5027`, raw TCP |
| Image | `813283043080.dkr.ecr.eu-north-1.amazonaws.com/paygo-api` |
| Security group | `sg-0af0eeb5de93c1ee4` (`paygo-api`) |
| Instance role | `paygo-instance` |

## Why one instance

A device's TCP socket lives on exactly one process. With two replicas, an enforcement
job on instance A cannot reach a tracker connected to instance B, and `sendCommand`
would return "not connected": a false negative that silently skips an immobilization.
Before running a second copy of this app, the socket registry has to become shared
(Redis-backed IMEI to instance map plus a pub/sub hop). Until then, "scale out" is a
change that requires that work first, not a knob to turn.

This is also why the device listener is not behind a load balancer and why the app
publishes port 5027 straight to the host: it is a raw binary protocol and cannot pass
through an HTTP proxy.

## Configuration

Every environment variable lives in **SSM Parameter Store** under `/paygo/env/`, with
secrets as `SecureString`. Nothing is baked into the image and no `.env` file is kept
in version control.

On each boot and each deploy, `/opt/paygo/render-env.sh` renders those parameters into
`/opt/paygo/.env` (mode 0600), which the app container reads. It refuses to write an
empty file, so a Parameter Store outage leaves the previous environment in place rather
than starting the app with nothing set.

```bash
# Read the current configuration (secrets redacted unless --with-decryption)
aws ssm get-parameters-by-path --path /paygo/env/ --recursive \
  --query 'Parameters[].Name' --output table

# Change one value and apply it
aws ssm put-parameter --name /paygo/env/LOCKOUT_WARNING_LEAD_HOURS \
  --value 24 --type String --overwrite
aws ssm send-command --instance-ids i-0220b4264b42d3958 \
  --document-name AWS-RunShellScript \
  --parameters commands=/opt/paygo/deploy.sh
```

Two parameters sit outside `/paygo/env/` because they are about the deployment rather
than the app: `/paygo/image` (the image reference the host converges onto) and
`/paygo/public-host` (what Caddy issues its certificate for).

## Access

There is **no SSH**. The security group opens 80, 443 and 5027 only, and shell access
is through SSM Session Manager, which authenticates with IAM and logs the session:

```bash
aws ssm start-session --target i-0220b4264b42d3958
```

## Deploying

Pushing to `master` runs `.github/workflows/deploy.yml`, which tests, builds, pushes to
ECR, updates `/paygo/image`, and asks the instance to converge. Deployment is
**pull-based**: CI never holds the application's secrets and never opens a port. It
sends one SSM command, and the instance fetches its own configuration and image.

Migrations are **not** automatic. Run the workflow manually from the Actions tab with
the `migrate` input checked, or apply them from a workstation:

```bash
DATABASE_URL="$(aws ssm get-parameter --name /paygo/env/DATABASE_URL \
  --with-decryption --query 'Parameter.Value' --output text)" \
  npm run migration:deploy
```

An automatic `prisma migrate deploy` on every push applies schema changes while the old
container is still serving, and a destructive migration then has no owner.

### Enabling CI access (one time)

The workflow authenticates with GitHub OIDC, so there is no AWS key in the repository.
Creating that trust is a standing grant, so it is a deliberate, separate step:

```bash
bash deploy/github-oidc-setup.sh
```

The trust policy names `refs/heads/master` and the `production` environment rather than
allowing any ref, so a pull request from a fork cannot push an image or run a command
on the instance.

## Manual operations

```bash
# Converge the host onto the image named in /paygo/image
aws ssm send-command --instance-ids i-0220b4264b42d3958 \
  --document-name AWS-RunShellScript \
  --parameters commands=/opt/paygo/deploy.sh

# Logs
aws ssm start-session --target i-0220b4264b42d3958
sudo docker compose -f /opt/paygo/docker-compose.yml logs -f app

# Roll back: point at a previous tag and redeploy
aws ecr list-images --repository-name paygo-api \
  --query 'imageIds[].imageTag' --output text
aws ssm put-parameter --name /paygo/image --type String --overwrite \
  --value 813283043080.dkr.ecr.eu-north-1.amazonaws.com/paygo-api:<tag>
```

The stack is a systemd unit (`paygo.service`), so it comes back on reboot, and the
containers carry `restart: unless-stopped`. A crash drops every device connection at
once and silently, which is what the unit and the restart policy are there for.

## Open items

- **TLS is a self-signed certificate** from Caddy's internal CA. Traffic is encrypted,
  but nothing proves the host is the one you meant to reach, and clients must skip
  verification to connect. Point a hostname at `13.61.227.223`, set
  `/paygo/public-host` to it, and remove `tls internal` from the Caddyfile: Caddy then
  gets a Let's Encrypt certificate and renews it on its own. Until then, staff
  passwords and refresh tokens are protected against passive eavesdropping only.
- **Port 5027 is open to `0.0.0.0/0`.** Devices roam on mobile APNs, so the source
  range is not known yet. The IMEI handshake is not authentication (an IMEI is
  guessable and spoofable), so narrow this to the operator's ranges once they are
  known.
- **No backups are configured here.** The database is external; whatever hosts it owns
  its backups. The instance holds no state worth keeping beyond the Caddy volumes.
- **No log shipping.** Container logs rotate locally (10 MB x 5 per container) and are
  lost when the instance is replaced.
