# GitHub Pages site

The public site is served at https://chrispatten.github.io/agentbus/ (no custom domain). It has two parts, published together to GitHub Pages by `.github/workflows/pages.yml`:

| URL | Source | Build |
|---|---|---|
| `/` | `site/`: the hand-written landing page | None; copied as-is |
| `/docs/` | `site-docs/`: the user documentation, in Markdown | [VitePress](https://vitepress.dev) |

`docs/` (this folder) is separate: internal technical documentation for operators and contributors, read on GitHub. It isn't published to the site. The user docs in `site-docs/` are written from the code and these internal docs, but for someone using AgentBus rather than reading its source.

## Layout

```
site/
  index.html    # the whole page — hero, what you can do, channels, control,
                #   how it works, getting started
  styles.css
  favicon.svg
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

The docs build for `/docs/` by default, which is what `docs:dev` and `docs:preview` use locally. The site has no custom domain, so GitHub serves it under `/agentbus/`, and the workflow sets `DOCS_BASE=/agentbus/docs/`. To check a production build locally:

```bash
DOCS_BASE=/agentbus/docs/ npm run docs:build
```

The landing page links to the docs with relative paths (`docs/`, `docs/getting-started`), so it works at any base without changes.

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

To move to a custom domain later, configure it in Settings → Pages → Custom domain, then change `DOCS_BASE` in the workflow to `/docs/`.

## Keeping content current

The landing page's version, license and last-commit badges are shields.io badges and update themselves. Everything else in `site/index.html` is hand-written copy.

When a change alters what users see or configure, update the matching page in `site-docs/` alongside `docs/`.

The landing page copy is aimed at users, not contributors: plain language, no terminal commands, and only shipped features (label early or extra-setup channels as such). Setup steps live in the documentation site. The release checklist in [VERSIONING.md](VERSIONING.md) includes reviewing `site/index.html` when a release changes user-facing behavior.
