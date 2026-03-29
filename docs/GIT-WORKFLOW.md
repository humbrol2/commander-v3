# Git Workflow — Fork Management

## Branch Strategy

| Branch | Purpose | Push rules |
|--------|---------|------------|
| `master` | Pure upstream mirror | Never commit here. Only `git pull upstream master`. |
| `local` | All local customizations | Rebase on master after upstream sync. Force-push OK. |

## Remotes

- **origin** — `malcolmpl/commander-v3` (your fork)
- **upstream** — `humbrol2/commander-v3` (source repo)

## Syncing with Upstream

```bash
git checkout master
git pull upstream master
git push origin master

git checkout local
git rebase master
# resolve conflicts if any
git push origin local --force-with-lease
```

If a commit on `local` was fixed upstream (e.g., the GROUP BY bug), drop it during rebase:

```bash
git rebase -i master
# mark the redundant commit as "drop"
```

## Checking Your Changes

```bash
# All custom commits:
git log --oneline master..local

# Full diff of customizations:
git diff master..local
```

## Adding New Features

Work directly on `local` or use temporary feature branches:

```bash
git checkout local
# ... make changes, commit ...
git push origin local
```

For larger features, use a worktree:

```bash
git worktree add ../commander-v3-work -b feature/my-feature local
# ... work in worktree ...
# when done, merge into local:
git checkout local
git merge feature/my-feature
git worktree remove ../commander-v3-work
git branch -D feature/my-feature
```

## Current Custom Commits (on `local`)

1. `7d35679` — OpenAI-compatible brain (LM Studio support)
2. `533f659` — PostgreSQL migration design spec
3. `783316c` — PostgreSQL migration implementation plan
4. `ad9c5cf` — Docker Compose for PostgreSQL (port 5433)
5. `4a77815` — Update drizzle.config.ts to local PostgreSQL
6. `9e4d552` — SQLite → PostgreSQL migration script
7. `1728548` — Fix GROUP BY query (PG compatibility)
8. `5b24cce` — Fix GameCache constructor (missing args)
9. `bcdf4df` — Fix timestamp serialization + missing tenantId args
