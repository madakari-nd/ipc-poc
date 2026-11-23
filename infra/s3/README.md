# Evidence store credentials

`s3.<profile>.json` (gitignored) is the SeaweedFS S3 identity file mounted by the `s3` service:

```json
{"identities":[{"name":"ipc","credentials":[{"accessKey":"<S3_ACCESS_KEY_ID>","secretKey":"<S3_SECRET_ACCESS_KEY>"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
```

Use the same pair as `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in `infra/compose/.env.<profile>`.
