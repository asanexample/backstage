export interface Config {
  /**
   * Platform projection plugin — reads the platform repo's XTenant claims from git (via the GitHub App)
   * and projects them into the catalog as Groups / Systems / Resources (ADR-049). See
   * docs/architecture/crossplane-tenant-api.md in the platform repo.
   */
  platformProjection?: {
    /** Platform repo URL. Default: https://github.com/asanexample/platform */
    repoUrl?: string;
    /** Path to the tenant-claims directory in the repo. Default: gitops/tenant-claims */
    claimsPath?: string;
    /** Path to the Team CRs directory. Each Team CR → a catalog Group (even with no tenants). Default: gitops/teams */
    teamsPath?: string;
    /** Branch to read. Default: main */
    branch?: string;
    /** ECR registry host, used only to title the ecr-repository Resources. */
    ecrRegistry?: string;
    /** How often (minutes) to re-read the claims and refresh the projected entities. Default: 5. */
    refreshMinutes?: number;
  };
}
