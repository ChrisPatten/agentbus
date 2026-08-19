# GitHub Pages homepage

A static landing page lives in `site/` and deploys to GitHub Pages via
`.github/workflows/pages.yml`. It's separate from `docs/` — this folder stays
internal technical documentation, rendered as-is on GitHub; `site/` is the
public-facing pitch.

## Layout

```
site/
  index.html    # the whole page — hero, architecture, features, quick start
  styles.css
  favicon.svg
  CNAME         # custom domain — replace the placeholder with the real one
```

No build step: the workflow uploads `site/` as-is.

## Deployment

`.github/workflows/pages.yml` triggers on push to `main` when anything under
`site/` (or the workflow file itself) changes, and can also be run manually
via `workflow_dispatch`. It uses `actions/upload-pages-artifact` +
`actions/deploy-pages` — no separate `gh-pages` branch.

One-time manual setup (repo Settings, not code):

1. Settings → Pages → Source: **GitHub Actions**.
2. Once DNS for the custom domain in `site/CNAME` is configured, enter that
   domain in Settings → Pages → Custom domain, then enable **Enforce HTTPS**.

## Keeping content current

The version/license/last-commit badges on the page are shields.io badges
pointed at the GitHub repo — they update automatically, no edits needed on
release.

Everything else (pitch, feature list, quick start commands) is hand-written
copy. The release checklist in [VERSIONING.md](VERSIONING.md) includes a
step to review `site/index.html` when a release changes user-facing
behavior — update it there rather than letting it drift from the README.
