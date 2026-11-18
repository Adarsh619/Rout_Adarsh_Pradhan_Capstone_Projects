# CLAUDE.md

## Working preferences

- Document every project thoroughly in a `docs/` folder, one numbered file per topic, with an index README and previous / index / next links (never one long file). Cover: overview, features, architecture with diagrams, design decisions, data model, API, frontend, background jobs, security, DevOps/CI, testing and performance results, challenges and next steps, setup.

## Two projects in one repo

| Project | Folder | CI | Live | Tags / releases |
|---|---|---|---|---|
| FS-01 ShopSphere | `FS-01/` | `.github/workflows/fs01-ci.yml` (runs only for `FS-01/**`) | https://shopsphere-fs01.vercel.app | `fs01-v*` (e.g. `fs01-v1.0.0`), never marked "Latest" |
| FS-04 TaskFlow | `FS-04/` | `.github/workflows/fs04-ci.yml` (runs for `FS-04/**`; any `v*` tag becomes a TaskFlow release) | https://taskflow-fs04.onrender.com | `v*` (e.g. `v2.0.0`) |

Each project is assessed on its own and is worked on in its own chat, often at the same time. Every chat follows these
rules:

- **Edit only your own project:** its folder, its own row of the root `README.md` and its own workflow file. Never
  edit, stage, revert or reformat the other project's files.
- **Shared parts** (this file, the root README's other sections, `.gitignore`) change only when the user asks.
- **Stage files by path** (`git add FS-01/…`), never `git add -A` at the repo root.
- **Before every push:** `git pull --no-rebase origin main` (the other project may have pushed), then
  `git push origin main`. Never push the other project's unpushed commits without asking the user first.
- **Tags:** FS-01 never creates a plain `v*` tag (it would publish a TaskFlow release); FS-04 never creates `fs01-v*`.
- Commit or push only after the user approves. Keys, passwords and connection strings never go into chat or Git.
- Each project's own `CLAUDE.md` (`FS-01/CLAUDE.md`, `FS-04/CLAUDE.md`) has its stack, commands and status.
