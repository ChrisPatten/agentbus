# GitHub Pages site

The public site has two parts, published together to GitHub Pages by `.github/workflows/pages.yml`:

| URL | Source | Build |
|---|---|---|
| `/` | `site/`: the hand-written landing page | None; copied as-is |
| `/docs/` | `site-docs/`: the user documentation, in Markdown | [VitePress](https://vitepress.dev) |

`docs/` (this folder) is separate: internal technical documentation for operators and contributors, read on GitHub. It isn't published to the site. The user docs in `site-docs/` are written from the code and these internal docs, but for someone using AgentBus rather than reading its source.

## Layout

```
site/
  index.html        # landing page: hero, architecture, features, quick start
  styles.css
  favicon.svg
  CNAME             # custom domain; replace the placeholder with the real one
site-docs/
  .vitepress/
    config.mts      # title, base path, nav, sidebar, local search
  public/           # static files copied to the docs root (favicon.svg)
  index.md          # "What is AgentBus?"
  getting-started.md
  concepts/  channels/  runtimes/  features/  reference/  operations/
```

The sidebar in `site-docs/.vitepress/config.mts` lists every page. Add new pages there.

## Working on the docs

```bash
npm install
npm run docs:dev       # live preview at http://localhost:5173/docs/
npm run docs:build     # production build into site-docs/.vitepress/dist
npm run docs:preview   # serve the production build
```

VitePress is a dev dependency only. `docs:build` fails on broken internal links, so run it before committing.

Markdown in `site-docs/` is compiled as Vue templates, so a literal `{{placeholder}}` must sit inside a fenced code block, or be written inline as `<code v-pre>{{placeholder}}</code>`. Anywhere else the build fails.

### Base path

The docs are built for `/docs/`. Set `DOCS_BASE` to build for another path, for example a GitHub project page without a custom domain:

```bash
DOCS_BASE=/agentbus/docs/ npm run docs:build
```

The VitePress logo links back to the landing page one level above the base.

## Deployment

The workflow runs on push to `main` when anything under `site/`, `site-docs/`, the workflow itself, `package.json` or `package-lock.json` changes, and on manual `workflow_dispatch`. It:

1. installs dependencies with `npm ci` on Node 22;
2. runs `npm run docs:build`;
3. assembles `_site/` from `site/` (unchanged, at the root) plus the VitePress output under `_site/docs/`;
4. uploads `_site/` with `actions/upload-pages-artifact` and deploys it with `actions/deploy-pages`. There is no `gh-pages` branch.

The deploy job only runs for `main`.

One-time manual setup (repo Settings, not code):

1. Settings → Pages → Source: **GitHub Actions**.
2. Once DNS for the custom domain in `site/CNAME` is configured, enter that domain in Settings → Pages → Custom domain, then enable **Enforce HTTPS**.

## Keeping content current

The landing page's version, license and last-commit badges are shields.io badges and update themselves. Everything else in `site/index.html` is hand-written copy.

When a change alters what users see or configure, update the matching page in `site-docs/` alongside `docs/`. The release checklist in [VERSIONING.md](VERSIONING.md) includes reviewing `site/index.html` when a release changes the pitch, feature list or quick start.
