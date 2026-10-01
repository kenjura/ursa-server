# Infra

| Folder | What | Status |
|---|---|---|
| `docker/` | Production image | Draft Dockerfile |
| `local/` | docker-compose for development: ursa-server + MinIO (S3 stand-in) | Draft |
| `terraform/` | AWS reference deployment | Placeholder: depends on QUESTIONS.md #1 |

The reference deployment (planned, assuming an always-on container/VM):

- **Source bucket** with S3 Event Notifications → **SQS queue** (the `s3`
  source's push mode).
- **Sink bucket**, private, behind **CloudFront** with Origin Access Control.
- **IAM role** for the server: read/write on the source prefix, consume the
  queue, write the sink, `cloudfront:CreateInvalidation` on the distribution.
- **Compute**: one ECS Fargate task (or a small EC2/Lightsail box) with a
  persistent volume (EFS or EBS) for `stateDir`.
- Optional: **Cognito / IAM Identity Center** as the OIDC issuer for the
  editor.
