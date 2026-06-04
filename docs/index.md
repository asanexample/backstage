# Backstage Developer Portal

This is the platform's developer portal — a [Backstage](https://backstage.io) instance that provides a
single window onto the GitOps + Crossplane + Kyverno platform.

## What's here

- **Software Catalog** — Components are auto-discovered from the `asanexample` app repos' `catalog-info.yaml`
  via a read-only GitHub App. **Systems**, **Groups**, and **Resources** are projected from the authoritative
  `XTenant` tenant claims in `gitops/tenant-claims/` (the `platform-projection` plugin), so the catalog mirrors
  the real tenant model: a Team owns a Tenant, a Tenant contains its apps and the infrastructure the Crossplane
  Composition provisions.
- **TechDocs** — this page. Docs are authored as Markdown in each repo's `docs/` directory and rendered here.

## Sign-in

Authentication is single sign-on through AWS Identity Center, brokered by Dex (`sso.aws.refplat.org`). See the
platform repo's `docs/runbooks/dex-sso.md` for the SSO architecture and operational notes.

## Operating the portal

The portal is deployed via Terragrunt (not GitOps): the `backstage` unit runs the official Helm chart against
our signed image. To roll a new build, bump the unit's `image_tag` to the new commit SHA and apply. See the
platform repo's `infra/modules/backstage` and `docs/architecture/crossplane-tenant-api.md` (the *Catalog
projection* section) for details.
