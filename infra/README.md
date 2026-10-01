# Infra

ursa-server is meant for an always-on machine: a home server, an EC2
instance, a VPS. It needs Node 24+, a disk for its state dir, and (for the
rsync sink) `rsync` and `ssh`.

| Folder | What |
|---|---|
| `systemd/` | Service unit. The simplest way to run it on a Linux box. |
| `aws/` | Minimal IAM policy for the S3 + CloudFront sink. |
| `docker/` | Image, if you'd rather run a container. |
| `local/` | docker-compose for trying the S3 sink locally against MinIO. |
| `terraform/` | Placeholder (bucket + CloudFront + IAM as code), if wanted later. |

## On a VPS or home server (systemd)

```bash
sudo useradd --system --create-home --home-dir /var/lib/ursa-server ursa
sudo npm install -g @kenjura/ursa-server          # once published; or a checkout + npm install
sudo mkdir -p /etc/ursa-server
sudo cp ursa-server.yml /etc/ursa-server/          # state-dir: /var/lib/ursa-server
sudo cp infra/systemd/ursa-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ursa-server
journalctl -u ursa-server -f
```

Put secrets (AWS keys, the control token) in `/etc/ursa-server/env`, which
the unit loads, and reference them as `${VAR}` in the config.

## S3 behind CloudFront

The setup this is built for: ursa-server holds the deploy credentials,
uploads to a private bucket, and CloudFront serves it. Editors (later) sign
in through Auth0 and never get AWS credentials.

1. A private bucket; a CloudFront distribution with the bucket as origin
   (Origin Access Control).
2. Ursa writes `foo.html` for `/foo` and `dir/index.html` for `/dir/`. S3 as a
   REST origin doesn't map those, so add a CloudFront Function on viewer
   request that appends `.html` to extensionless paths and `index.html` to
   paths ending in `/`.
3. An IAM user (or, on EC2, an instance role) with
   [aws/iam-policy.json](aws/iam-policy.json), with the bucket name and
   distribution id filled in.
4. In the config: `sink: { type: s3, bucket: …, cloudfront: { distribution-id: … } }`.

HTML and JSON are uploaded with `Cache-Control: public, max-age=0,
must-revalidate`, so browsers revalidate. Changed files are also invalidated
in CloudFront after each deploy.
