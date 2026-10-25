# UI/UX design brief · TaskFlow

[← Implementation plan](04-implementation-plan.md) · [Index](../README.md) · [Next: Backend schema →](06-backend-schema.md)

## 1. Design goal

A calm, fast work tool: people should see **what to do next** at a glance and move work with one drag. The interface stays quiet so the content (issues, columns, people) stands out.

## 2. Audience

| Persona | Device | What the UI must make easy |
|---|---|---|
| Owner | Laptop | Setup, members, plan and usage |
| Admin / manager | Laptop, large screen | Configure workflows and sprints; scan the board and audit log |
| Member / developer | Laptop | Find their cards, drag, comment, attach |
| Viewer / stakeholder | Laptop or phone | Read progress without risk of changing anything |

## 3. Design principles

1. **Content first:** neutral chrome, colour only where it means something (status, priority, danger).
2. **Direct manipulation:** drag cards instead of filling forms; changes appear instantly (optimistic UI).
3. **Prevent, then explain:** forbidden moves are dimmed during a drag; if something fails, a plain message explains why.
4. **Role-aware:** controls a role cannot use are hidden, never shown and then refused.
5. **Honest states:** loading, empty and error states are always visible; mock billing is clearly labelled as simulated.

## 4. Information architecture

```
Login / Register
└── Workspace picker
    └── Workspace (/w/:slug)  ← sidebar on every page
        ├── Projects
        │   └── Project
        │       ├── Board
        │       └── Backlog & sprints
        ├── Members
        ├── Reports              (member+)
        ├── Workflows            (admin+)
        ├── Webhooks             (admin+)
        ├── Audit log            (admin+)
        └── Billing
            └── Checkout (mock mode)
```

## 5. Layout

| Region | Content |
|---|---|
| Sidebar (240 px, sticky) | Workspace name, plan and role; project list; workspace pages; user name + sign out |
| Top bar | Notifications bell with unread count |
| Content (20 px padding) | Page title row with primary action on the right, then filters, then content |
| Modal (900 px wide) | Issue details: form on the left, fields on the right, tabs for comments / attachments / history |

## 6. Key screens

| Screen | Purpose | Primary action | Notes |
|---|---|---|---|
| Kanban board | See and move work | Drag a card; **+ Issue** | Columns = workflow statuses with a coloured top border and count; filters: search, sprint, assignee |
| Issue modal | Read and edit one issue | Save changes | Type, priority, status, assignee, sprint, points, due date; comments, attachments, history tabs |
| Backlog & sprints | Plan sprints | Create / start / complete sprint | Grouped by sprint with issue count and story points |
| Projects | Overview of projects | Create project (admin) | Cards with key, description, issue count, links |
| Workflows | Configure statuses and transitions | Add status / transition | Status chips with colour; transitions listed as "A → B" |
| Billing | Plan, usage, upgrade | Upgrade | Usage meters turn red at ≥ 90%; plan cards |
| Mock checkout | Simulated payment | Subscribe | Striped yellow "SIMULATED STRIPE CHECKOUT" banner |

Screenshots: [board](../assets/screenshots/board.png), [issue](../assets/screenshots/issue.png), [billing](../assets/screenshots/billing.png), [mock checkout](../assets/screenshots/mock-checkout.png).

## 7. Visual language

### Colour tokens (`frontend/src/styles.css`)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f6f7fb` | `#0f1220` | Page background |
| `--panel` | `#ffffff` | `#181c2e` | Cards, panels, sidebar |
| `--text` | `#1e2333` | `#e5e7f0` | Body text |
| `--muted` | `#6b7280` | `#9aa0b4` | Secondary text, labels |
| `--border` | `#e5e7eb` | `#2a2f45` | Borders, dividers |
| `--primary` | `#4f46e5` | `#4f46e5` | Primary buttons, links, active nav, avatars |
| `--danger` | `#dc2626` | `#dc2626` | Destructive actions, errors, limit warnings |
| `--col` | `#eef0f5` | `#141829` | Board column background, badges |

Dark mode follows the operating system (`prefers-color-scheme`).

### Meaning colours

| Element | Colours |
|---|---|
| Default statuses | To Do `#64748b` · In Progress `#2563eb` · In Review `#9333ea` · Done `#16a34a` (editable per status) |
| Priority chips | Low blue · Medium yellow · High orange · Critical red |
| Sprint state | Active green · Planned indigo · Closed grey |
| Issue type icons | 🐞 bug · 📗 story · ✅ task · ⚡ epic |

### Typography and shape

- Font: Inter, falling back to the system UI font
- Sizes: page title 1.35 rem, section 1.05 rem, body 1 rem, small 0.82 rem
- Corners: 8 px on inputs and buttons, 10 px on cards, 12 px on panels and columns
- Shadows: one subtle shadow on cards in light mode; none in dark mode

## 8. Components

| Component | States |
|---|---|
| Button | default, primary, danger, ghost, link; disabled while saving |
| Issue card | default; hover (primary border); dragging; read-only (viewer) |
| Board column | default; drag-over (tinted primary); blocked (45% opacity) |
| Modal | opens on top; closes with ✕, Esc, or a click outside |
| Toast | bottom-right, auto-hides after 3.5 s (errors, blocked moves) |
| Badge / pill | issue key, project key, role, plan, status |
| Meter | usage vs limit; red at ≥ 90% |
| Notification dropdown | unread items marked with a left border; "Mark all read" |

## 9. Interaction details

| Interaction | Behaviour |
|---|---|
| Drag a card | Lifts the card; dims forbidden columns; drops instantly; rolls back with a toast if the server refuses |
| Keyboard drag | Focus a card → Space to lift → arrows to move → Space to drop |
| Create issue | **+ Issue** or **+ Add** at the foot of a column (pre-selects that status) |
| Open issue from a notification | Clicking a notification opens the board with that issue's modal |
| Plan limit | Error message names the limit and points to Billing |

## 10. Accessibility and responsiveness

- Keyboard-operable drag-and-drop; focusable controls; Esc closes modals
- Text and meaning colours chosen for contrast in both themes; status is shown as text, not colour alone
- Layout collapses to one column under 800 px (sidebar stacks above content; issue form fields stack)
- Board scrolls horizontally on narrow screens; columns keep a 280 px width

## 11. Future UX improvements

- Inline editing of title and status on cards
- Avatars with photos; @mentions in comments
- Board swimlanes by assignee; WIP limits per column
- Burndown chart on the sprint page
