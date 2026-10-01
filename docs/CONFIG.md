# Config

One YAML (or JSON) file, `ursa-server.yml` in the working directory by
default (or `ursa-server start path/to/config.yml`). Same conventions as
Ursa's build config (`ursa/docs/BUILD_CONFIG.md`): kebab- or camelCase keys,
relative paths resolve against the config file's folder, `~` is your home
folder, CLI flags win. `${VAR}` and `${VAR:-default}` are substituted from the
environment in any string, so secrets stay out of the file; an unset variable
with no default is an error.

Unknown keys are warned about and ignored. A value of the wrong type stops
startup with the key's path (`sites[0].sink.bucket: required`).

## Full example

```yaml
state-dir: ./.ursa-server        # caches and deploy state (default: .ursa-server beside the config)

roles:
  watch: true                    # follow source changes (false: build once at startup)
  serve: false                   # dev server with live reload
  edit: false                    # editor at /edit/ (needs serve; docs/EDITOR.md)

server:                          # the dev server (roles.serve)
  host: 127.0.0.1
  port: 8080
  site: wiki                     # which site to serve (default: the first)
  access: public                 # public | viewer | editor | admin (needs `auth`)

editor:
  max-upload-mb: 50              # largest file the editor accepts

control:                         # control API (docs/CONTROL.md)
  enabled: true
  host: 127.0.0.1                # a non-loopback host requires a token
  port: 7071
  socket: ./.ursa-server/control.sock   # optional; trusted, mode 0600
  token: ${URSA_SERVER_TOKEN:-}

sites:
  - id: wiki                     # letters, digits, - and _
    ursa:                        # passed to Ursa's build
      meta: ./meta               # default: Ursa's bundled templates
      exclude: [legacy]
      whitelist: ./whitelist.txt
      directory-json: true
      directory-depth: 2         # or infinite
      json-only: false
      concurrency: 50
      explain: false

    source:
      type: fs
      path: ~/wiki/docs

    sink:
      type: s3
      bucket: wiki.example.com
      prefix: ""                 # key prefix inside the bucket
      region: us-east-1
      # endpoint: https://<account>.r2.cloudflarestorage.com   # R2, B2, MinIO…
      # force-path-style: true                                 # MinIO
      # credentials:             # default: AWS chain (env, ~/.aws profile, instance role)
      #   access-key-id: ${AWS_ACCESS_KEY_ID}
      #   secret-access-key: ${AWS_SECRET_ACCESS_KEY}
      #   profile: wiki-deployer
      cache-control:
        html: "public, max-age=0, must-revalidate"
        json: "public, max-age=0, must-revalidate"
        assets: "public, max-age=3600"
      cloudfront:
        distribution-id: E123ABC
        max-paths: 25            # more changed paths than this → invalidate /*
```

`auth` (sign-in with Auth0 or any OIDC provider) is documented in
[AUTH.md](AUTH.md#config). [ursa-server.example.yml](../ursa-server.example.yml)
is a complete starting point with Auth0.

## Secrets and `.env`

`ursa-server` loads `.env` beside the config (or `--env-file path`) before
reading it. Variables already set in the environment win. Keep `.env` out of
version control; [.env.example](../.env.example) lists what the example
config uses.

## Sources

| Type | Keys | Status |
|---|---|---|
| `fs` | `path` | Implemented |
| `s3` | `bucket`, `prefix`, `region`, `notifications: { type: sqs, queue-url }` or `poll` | M3 |
| `dropbox` | `path`, `token` | M3 |
| `gdrive` | `folder-id`, `credentials` | M3 |

## Sinks

| Type | Keys | Notes |
|---|---|---|
| `fs` | `path` | The site is built directly into `path`. Nothing to deploy. Default when `sink` is omitted (then the build goes to `state-dir/sites/<id>/out`). |
| `s3` | see example | Needs `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, and `cloudfront:CreateInvalidation` if `cloudfront` is set: [infra/aws/iam-policy.json](../infra/aws/iam-policy.json). |
| `rsync` | `target`, `ssh-key`, `port`, `args` | `target` is `user@host:/path` or a local folder, and must exist. SSH runs non-interactively, so use a key without a passphrase, or an agent. |

```yaml
sink:
  type: rsync
  target: bitnami@52.87.178.252:/home/bitnami/db/ursa
  ssh-key: ~/.ssh/wiki.bertball.com.pem
  # port: 2222
  # args: ["--chmod=F644,D755"]
```

## Without a config file

```bash
ursa-server start --source ./docs [--output ./site] [--meta ./meta] [--serve] [--edit] [--port 8080] [--no-watch]
```

One site, `fs` source, `fs` sink (`--output`, default `./output`). Paths are
relative to the working directory. `--edit` (which implies `--serve`) adds
the editor; without a config there's no sign-in, so it only works on
localhost.
