# GitHub Pages homepage

A static landing page lives in `site/` and deploys to GitHub Pages via
`.github/workflows/pages.yml`. It's separate from `docs/` — this folder stays
internal technical documentation, rendered as-is on GitHub; `site/` is the
public-facing pitch.

## Layout

```
site/
  index.html    # the whole page — hero, what you can do, channels, control,
                #   how it works, getting started
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

Everything else (pitch, use cases, channel list, requirements) is
hand-written copy aimed at users, not contributors: plain language, no
terminal commands. Setup steps live in the documentation site; the page links
to `/docs/` and `/docs/getting-started`, so keep those paths in sync if the
docs site moves. Only describe shipped features, and label early or
extra-setup channels as such. The release checklist in [VERSIONING.md](VERSIONING.md) includes a
step to review `site/index.html` when a release changes user-facing
behavior — update it there rather than letting it drift from the README.
