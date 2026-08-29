# Good Gateway documentation content

This directory contains the platform-neutral source content for the future documentation portal at `docs.goodgateway.dev`.

The canonical source language is English. Pages use MDX with YAML frontmatter but intentionally avoid renderer-specific components, imports, and directives. A future portal can ingest the files as plain Markdown or add its own presentation components without rewriting the content.

## Content principles

- Lead with outcomes and complete user journeys, then link to detailed references.
- Distinguish a ready capability from a preview, an entitlement, and an unreleased roadmap item.
- Document both the Operations Console path and the operational consequences of each action.
- State fail-closed behavior, recovery behavior, and ownership boundaries for destructive or security-sensitive workflows.
- Never include real credentials, private addresses, customer topology, or production screenshots containing secrets.
- Keep UI labels in bold and API paths or configuration values in code.

## Screenshot markers

Pages may contain comments in this form:

```md
<!-- screenshot: id=dashboard-overview; viewport=1440x900; description=Gateway dashboard after nodes are online; redact=hostnames,public-ip -->
```

The consolidated capture list is maintained in [SCREENSHOTS.md](SCREENSHOTS.md).

## Source-of-truth policy

Before publishing a release, compare this content with:

- the current Operations Console;
- `docs/capabilities.md`, `docs/security.md`, `docs/licensing.md`, `docs/nodes.md`, `docs/operations.md`, and `docs/inference.md`;
- backend route schemas and entitlement checks;
- daemon installers and supported node profiles;
- the embedded AI documentation in `packages/backend/src/modules/ai/`.
