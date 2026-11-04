---
description: Bind this repository to a TokenScope project budget by writing a .tokenscope file at the repo root
argument-hint: '[project code or search text]'
---

# tokenscope-project — Bind This Repo to a Budget

Tag the current repository to a TokenScope **project budget** by writing a
committed `.tokenscope` file at the repo root.

## When to Use

- Setting up a repo so its Copilot CLI sessions attribute to the right budget.
- Re-pointing a repo to a different budget.
- You don't know the exact project code and want to pick from a list.

## Workflow

### Step 1: List your budgets

Call **`list_my_projects`** — the budgets you are a current member of. Each has an
`id`, `code`, and `display_name`. The value written to `.tokenscope` is the project
**`code`** (the stable slug), not the UUID.

### Step 2: Present and let the user pick

Show the budgets as a short numbered list (code + display name). Ask which budget
this repository's work should bill to.

If a project code or search text was passed as the skill argument, match it against
the listed budgets first (by `code` or `display_name`) and confirm rather than
guessing.

### Step 3 (optional): Confirm the code resolves

You may call **`resolve_repo_project`** with the chosen `code` to confirm it maps
to a budget you are a member of and echo back its `display_name` and `type`. If it
reports the code is not a member project, do not write the file; re-pick from
`list_my_projects`.

### Step 4: Write `.tokenscope`

Write a file named exactly `.tokenscope` at the **repository root**. It MUST be the
YAML `project:` block below, with the chosen project code on an indented `code:`
line — copy this shape exactly, substituting the code:

```
# TokenScope — commit this so the project tag travels with the repo.
project:
  code: <project code>
```

For example, for the code `TokenScope-MVP`:

```
# TokenScope — commit this so the project tag travels with the repo.
project:
  code: TokenScope-MVP
```

Use your own file-writing tool — the MCP server never writes the user's disk. Keep
the indented `project:` / `  code:` form: it is the documented shape, and the one
every plugin version reads. Older plugin versions read the code ONLY
from an indented `code:` line under `project:`, so on those a bare one-line file
(just the code) left the repo **untagged**.

If a `.tokenscope` already exists with a different code, show the old and new values
and confirm before overwriting.

### Step 5: Confirm and advise committing

Tell the user:

- The repo is now bound to budget **{code}** ({display_name}).
- **Commit `.tokenscope`** so teammates attribute to the same budget — it holds
  only a non-secret project code.
- TokenScope reads this committed `.tokenscope` and tags this repo's Copilot spend to
  the budget automatically, from the **next** Copilot session started in this repo.
- Each Copilot session is tagged from its own working directory, so repos open at the
  same time on one host are tagged independently.
