# 14-Day Commit Plan

[← Accounts and setup checklist](ACCOUNTS_SETUP.md) · [Index](../README.md) · [Next: Presentation outline →](PRESENTATION_OUTLINE.md)

The code is complete. This plan splits it into **small, reviewable daily commits** so your GitHub history shows
steady progress. Each day: read the files, run them, change what you'd like, then commit.

> **What actually happened:** the whole project had already been committed at once (`28a62ed`), so the table below
> was used as the **review order** instead: each day took that day's area, reviewed it, fixed what the review found with
> tests and docs, and committed the result. The real commits are listed in
> [13 · Day-by-day review](../13-challenges-and-next-steps.md#day-by-day-review-days-214).

> Earlier commits won't run on their own, because `config/urls.py` and `settings.py` already reference every app.
> From Day 7 on, `pytest` passes after each commit. Test as you go with `pytest tests/<file>` once that file is committed.

Repository layout: the Git repo's root is `Rout_Adarsh_Pradhan_Capstone_Projects`, and this project lives in its `FS-04/` subfolder.
The pipeline must sit at the **repo root** (`.github/workflows/fs04-ci.yml`), so on Day 13 move it up one level (see that row).

Open the `FS-04` folder in VS Code. When it asks to open the Git repository in the parent folder, choose **Always**.
Paths in the table are relative to `FS-04`. Run the commands from a terminal inside `FS-04`, or stage the files in the Source Control panel.

| Day | Theme | `git add` | Suggested commit message |
|---|---|---|---|
| 1 | Repo scaffold & tooling | `.gitignore .gitattributes .env.example .vscode backend/requirements*.txt backend/manage.py backend/ruff.toml backend/pytest.ini backend/config backend/apps/__init__.py` | `chore: scaffold Django project, tooling and VS Code config` |
| 2 | Users & auth | `backend/apps/accounts` | `feat(accounts): email-based user model with JWT register/login` |
| 3 | Tenancy & roles | `backend/apps/tenancy` | `feat(tenancy): workspaces, memberships, role-based permissions, tenant scoping` |
| 4 | Domain models | `backend/apps/tracker/__init__.py backend/apps/tracker/apps.py backend/apps/tracker/models.py backend/apps/tracker/migrations backend/apps/tracker/admin.py` | `feat(tracker): workflow, project, board, sprint, issue, comment, attachment models` |
| 5 | Issues API & workflows | `backend/apps/tracker/serializers.py backend/apps/tracker/services.py backend/apps/tracker/views.py` | `feat(api): REST endpoints for projects, boards, sprints, issues, workflow transitions` |
| 6 | Audit log | `backend/apps/audit` | `feat(audit): append-only audit log with field-level diffs` |
| 7 | Tests + seed data | `backend/tests/__init__.py backend/tests/conftest.py backend/tests/test_auth_and_tenancy.py backend/tests/test_issues_and_workflows.py backend/apps/tracker/management` | `test: tenant isolation, RBAC and workflow tests; Faker seed command` |
| 8 | Celery & webhooks | `backend/apps/integrations backend/tests/test_integrations.py` | `feat(integrations): Celery jobs, signed webhooks, notifications, weekly reports` |
| 9 | Stripe billing | `backend/apps/billing backend/tests/test_billing.py backend/tests/test_seed_and_perf.py backend/config/settings.py backend/config/urls.py .env.example` | `feat(billing): Stripe subscriptions, plan limits, webhook sync and stripe-mock mode` |
| 10 | React foundation | `frontend/package.json frontend/package-lock.json frontend/vite.config.js frontend/eslint.config.js frontend/index.html frontend/public frontend/src/main.jsx frontend/src/App.jsx frontend/src/api.js frontend/src/auth.jsx frontend/src/workspace.jsx frontend/src/styles.css frontend/src/pages/Login.jsx frontend/src/pages/Register.jsx frontend/src/pages/Workspaces.jsx frontend/src/components/Layout.jsx frontend/src/components/Modal.jsx frontend/src/components/Notifications.jsx` | `feat(web): React app shell, auth flow, workspace switcher` |
| 11 | Kanban board | `frontend/src/boardLogic.js frontend/src/components/IssueCard.jsx frontend/src/components/IssueModal.jsx frontend/src/pages/Board.jsx frontend/src/pages/Sprints.jsx frontend/src/pages/Projects.jsx frontend/src/test` | `feat(web): drag-and-drop Kanban board, issue details, sprints` |
| 12 | Admin pages | `frontend/src/pages` | `feat(web): members, workflows, webhooks, audit log, reports and billing pages` |
| 13 | Docker & CI/CD | First move the workflow to the repo root (see below), then add `docker-compose.yml backend/Dockerfile backend/entrypoint.sh backend/.dockerignore frontend/Dockerfile frontend/nginx.conf frontend/.dockerignore ../.github` | `ci: Docker Compose stack and GitHub Actions test/build/deploy pipeline` |
| 14 | Docs & demo | `README.md docs` | `docs: README, architecture diagram, API docs, test results` |

Day 13: move the pipeline to the repo root (PowerShell, from the `FS-04` folder):

```powershell
Move-Item .github ..\.github
```

Each day:

```bash
git add <paths from the table>
git status            # check that only what you expect is staged
git commit -m "<message>"
git push origin main   # or click Sync Changes in VS Code
```

Tips:
- `backend/config/settings.py`, `urls.py` and `.env.example` were committed on Day 1 and changed later (Stripe mock mode). They show as *modified* in Source Control. Commit them on Day 9 as listed.
- In VS Code, the **Source Control** panel (Ctrl+Shift+G) lets you stage individual files with the `+` button instead of typing paths.
- If you change something on a later day, commit it separately, for example `fix(board): keep scroll position after drag`. Real fixes make the history more believable and teach you more.
- Keep a short daily note (what you built, what broke, what you learned). It feeds straight into your reflection.
