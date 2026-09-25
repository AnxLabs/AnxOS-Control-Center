# Private Alpha Release Process

1. Start from a clean committed `dev` checkout.
2. Run `npm ci`, `npm run versioning:smoke`, `npm run rc:validate`, and `npm run packaging:smoke`.
3. Configure Azure Trusted Signing secrets for signed Windows releases:
   `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
   `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
   `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and
   `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
4. Trigger the Desktop Release workflow. Validation must pass before either platform packages.
5. Confirm Windows signing and signtool verification pass for every executable. Confirm Linux packages upload successfully.
6. For a tagged run, review the generated updater manifest, checksums, release notes, and artifact inventory before publication.

Unsigned local builds are supported when no Azure variables are configured. Partial Azure configuration is rejected to prevent accidental unsigned releases. The workflow does not publish from manual runs; publication is tag-only.

Troubleshooting should begin with the failing job and step, then reproduce the corresponding smoke or packaging command locally. Do not bypass validation or signature verification.
