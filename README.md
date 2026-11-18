# Rout Adarsh Pradhan · Capstone Projects

Full-stack projects built during my internship, based on real-world applications.
Each project lives in its own folder with its own code, setup instructions and documentation.

**Live demos:** [ShopSphere (FS-01)](https://shopsphere-fs01.vercel.app) · [TaskFlow (FS-04)](https://taskflow-fs04.onrender.com)

## Projects

| ID | Project | Description | Tech stack | Docs |
|---|---|---|---|---|
| [FS-01](FS-01) | **ShopSphere**: multi-vendor e-commerce marketplace · [live demo](https://shopsphere-fs01.vercel.app) | An Amazon-style marketplace where many vendors sell, customers buy from several in one checkout, and the platform splits each payment and keeps a commission | React · Node.js (Express, TypeScript) · PostgreSQL · Prisma · Elasticsearch · Redis · AWS S3 · Razorpay (test mode) · Docker · GitHub Actions | [README](FS-01/README.md) · [Documentation](FS-01/docs/README.md) |
| [FS-04](FS-04) | **TaskFlow**: multi-tenant SaaS project management · [live demo](https://taskflow-fs04.onrender.com) | A Jira-style platform where each company gets an isolated workspace with drag-and-drop Kanban boards, sprints, custom workflows, an audit log, webhooks and Stripe subscription billing | React · TypeScript · Node.js (Express) · PostgreSQL · Prisma · BullMQ · Redis · Stripe (test mode) · Vitest · Docker · GitHub Actions | [README](FS-04/README.md) · [Documentation](FS-04/docs/README.md) |

## Repository structure

```
Rout_Adarsh_Pradhan_Capstone_Projects/
├── .github/workflows/   CI/CD pipelines (one per project: fs01-ci.yml, fs04-ci.yml)
├── FS-01/               ShopSphere: code, Docker setup and docs/
├── FS-04/               TaskFlow: code, Docker setup and docs/
└── README.md            this file
```

## Running a project

Every project is self-contained: open its folder and follow its README (Docker is all you need to run either one).

```bash
cd FS-01                    # or FS-04
cp .env.example .env        # Windows: copy .env.example .env
docker compose up --build
```

Then open http://localhost:3000. Both projects use port 3000 by default; to run them side by side, change one
project's port as its README explains.

## Documentation standard

Every project includes a `docs/` folder with one numbered file per topic: overview, architecture, data model, API, testing, challenges and setup, plus an index.
