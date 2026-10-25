# Rout Adarsh Pradhan · Capstone Projects

Full-stack projects built during my internship, based on real-world applications.
Each project lives in its own folder with its own code, setup instructions and documentation.

## Projects

| ID | Project | Description | Tech stack | Docs |
|---|---|---|---|---|
| [FS-04](FS-04) | **TaskFlow**: multi-tenant SaaS project management | A Jira-style platform where each company gets an isolated workspace with drag-and-drop Kanban boards, sprints, custom workflows, an audit log, webhooks and Stripe subscription billing | Django REST Framework · React · PostgreSQL · Celery · Redis · Stripe · Docker · GitHub Actions | [README](FS-04/README.md) · [Documentation](FS-04/docs/README.md) |

## Repository structure

```
Rout_Adarsh_Pradhan_Capstone_Projects/
├── .github/workflows/   CI/CD pipelines (one per project, e.g. fs04-ci.yml)
├── FS-04/               TaskFlow: code, Docker setup and docs/
└── README.md            this file
```

## Running a project

Every project is self-contained. Open its folder and follow its README. For FS-04:

```bash
cd FS-04
cp .env.example .env        # Windows: copy .env.example .env
docker compose up --build
```

Then open http://localhost:3000.

## Documentation standard

Every project includes a `docs/` folder with one numbered file per topic: overview, architecture, data model, API, testing, challenges and setup, plus an index.
