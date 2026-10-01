# Config

One YAML (or JSON) file. Same conventions as Ursa's build config
(`ursa/docs/BUILD_CONFIG.md`): kebab- or camelCase keys, relative paths resolve
against the config file's folder, CLI flags win. `${ENV_VAR}` is substituted
in any string so secrets stay out of the file.

```yaml
stateDir: ./.ursa-server

roles:
  watch: true
  serve: true
  edit: true

server:
  port: 8080
  host: 127.0.0.1

control:
  host: 127.0.0.1
  port: 7071
  socket: ./.ursa-server/control.sock
  token: ${URSA_SERVER_TOKEN}

sites:
  - id: bertball
    # Everything under `ursa` is passed to Ursa's createBuild()
    ursa:
      meta: ./meta
      exclude: [legacy]
      directory-depth: 2

    source:
      type: s3
      bucket: bertball-src
      prefix: docs/
      region: us-east-1
      notifications:
        type: sqs
        queueUrl: https://sqs.us-east-1.amazonaws.com/123/bertball-src-events
      # credentials: default AWS chain (env, profile, instance role)

    sink:
      type: s3
      bucket: wiki.bertball.com
      cloudfront:
        distributionId: E123ABC
      cacheControl:
        html: "no-cache"
        assets: "public, max-age=31536000, immutable"

auth:
  providers:
    - preset: auth0
      domain: kenjura.us.auth0.com
      clientId: abc
      clientSecret: ${AUTH0_CLIENT_SECRET}
    - type: token
      tokens: [${URSA_SERVER_TOKEN}]
  roles:
    admin: [andrew@kenjura.com]
    editor: ["*@kenjura.com"]
```

Other source/sink shapes:

```yaml
source: { type: fs, path: ~/wiki/docs }
source: { type: dropbox, path: /Apps/ursa/bertball, token: ${DROPBOX_REFRESH_TOKEN} }
source: { type: gdrive, folderId: 1AbC..., credentials: ./gdrive-sa.json }
sink:   { type: fs, path: ./output }
sink:   { type: rsync, target: bitnami@52.87.178.252:/home/bitnami/db/ursa, sshKey: ~/.ssh/wiki.pem }
```

Validation: a JSON schema in `src/config/schema.js`; unknown keys warn (as
Ursa does), wrong types fail at startup with the key path.
