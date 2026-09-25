# tau — hand-over for a new session

Read this file first, then `README.md` (the target spec). This file tells
what is done, how the code is organized, how we work, and what comes next.

## 1. First action for the new session

1. Run `npm run check` in `~/Development/RomainMuller/tau` (typecheck + 299
   tests, about 15 s). All must pass.
2. Run `jj log -r '::@' --limit 10` to see the commits below.
3. Ask Romain which next step to start (see section 8). The proposal is
   step 6: the "do not stop" rule and `tau_ask_user`.

## 2. What tau is

`tau` is a pi extension (pi 0.87.1, Node 26, TypeScript 7 with native type
stripping). A lead agent plans work as a task list, and delegates tasks to pi
sub-agents in herdr panes. `README.md` describes the complete product as if it
is done; it is the spec. Some README features are not built yet (section 8).
The README header says "Status: DRAFT".

Install target: `pi install git:github.com/RomainMuller/tau` (not published
yet). Local run: `pi -e ./src/index.ts` from the repo, inside a herdr pane.

## 3. Rules for working with Romain (MUST follow)

- Write all English (answers, comments, docs, error messages) in ASD-STE100
  Simplified Technical English. Romain is a native French speaker.
- Follow the `audhd` skill for every answer: first line = next action,
  numbered steps, restate state, specific time estimates, visible wins, no
  preamble or closers, lists of at most 5 items.
- Use `jj` only. Never run `git` commands. Commit with `jj commit` after each
  delivered step (conventional commits; body tells why). Before code changes,
  the working copy must be empty and described: `jj describe -m "wip: …"`.
- For choices, use the `ask_user_question` tool, with previews when useful.
  Before a question, report the herdr pane as blocked:
  `herdr pane report-agent "$HERDR_PANE_ID" --source tau-readme --agent pi --state blocked --message "…"`,
  and set `--state working` after the answer.
- Non-trivial code needs the `code-review` skill: parallel read-only
  reviewers, tier 4/5 model from a DIFFERENT foundry than the implementer
  (the implementer so far is Anthropic Claude Opus, so reviewers use
  `ai-gw-openai/openai/gpt-6-sol`, thinking `high`), with 4 duties
  (correctness, security, API/docs, tests). Then at most 2 follow-up
  rounds. If a fix comes after the last round, tell Romain and ask; so far
  he approved to commit with a note "not reviewed again" in the commit body.
- Use the `Agent` tool for reviewers (the old task-list plugin that blocked
  it is removed now).
- Romain wants you to test in herdr yourself (you have the herdr CLI). See
  section 6.

## 4. Commits so far (all on the main line, not pushed)

| Change     | Commit    | Message                                                    |
|------------|-----------|------------------------------------------------------------|
| `ptxtvrxz` | `ca9f8b11` | docs: draft README for the tau pi extension               |
| `trvoqysy` | `56a96b23` | docs: add agent messages and task notes to README         |
| `qvnqklzq` | `0703f9a6` | feat: detect herdr and show a status badge                |
| `ytqpnnny` | `db9973f6` | feat: add the task list model, rules, and SQLite storage  |
| `pwsvvvkl` | `abe6fe5a` | feat: add the task tools and the work gate                |
| `tltkpzyk` | `bd9b13df` | feat: show the task tree under the herdr badge            |
| `ykktntvt` | `380c457f` | feat: delegate tasks to pi sub-agents in herdr panes      |

The working copy after that is empty.

## 5. Code map (`src/`)

| File | Does |
|------|------|
| `index.ts` | Extension entry. `session_start`: herdr check → identity → open store → register tools, gate, commands, widget, supervisor → report pane metadata. `session_shutdown`: stop timers, close store, clear metadata. `createTau(pi, deps)` for tests (returns a `TauHandle`). |
| `herdr.ts` | `detectHerdr`: needs `HERDR_ENV=1`, absolute `HERDR_BIN_PATH` (no PATH search), and `herdr pane current --current` with a pane ID. |
| `herdr-client.ts` | Wrapper for herdr CLI: split, start pi (retries `agent_pane_busy`), prompt, list agents (with pi session), list/close panes, report/clear metadata. `HerdrError.herdrCode`. |
| `identity.ts` | Lead vs sub-agent. Sub-agent env: `TAU_TASKLIST`, `TAU_TASK_ID`, `TAU_AGENT_NAME`, `TAU_PARENT_AGENT`. `checkSubAgent` needs record name/task/parent/pane to agree. Cooperative, not a security boundary. |
| `delegate.ts` | `delegate()`: reserve (claim for the new agent name), split pane with env, record pane, `herdr agent start … -- --model --thinking --extension <tau>`, mark running, first prompt. Cleanup on failure. |
| `supervisor.ts` | Liveness every 5 s for the children of this agent. Knows a child by its pi session (name+pane only in the 2-min start grace). Dead child → fail tasks of it and its descendants (`owner agent exited`). Finished child (task closed, no live sub-agents, idle or 2 min after the close) → end. Safe pane close rule. Dry run on a copy, so no write without a change. |
| `names.ts` | Agent names `tau-t2-1`, `-2` suffix for retries, hash names for deep IDs. |
| `tools.ts` | 11 tools: `tau_list/get/create/update/claim/complete/fail/cancel/note/delegate/wait`. All `executionMode: "sequential"`. Identity from the process, never from args. `conflictingTools` (another extension with a tau name → tau registers nothing). |
| `gate.ts` | Work gate on `tool_call`: no active task → block non-tau tools; read-only type (or unknown type) → block `edit`/`write`. |
| `format.ts` | Model-facing text. Agent text is quoted with `| ` and labeled as data. `tau_get` previews (2000 chars, last 10 notes/events) and `section`+`offset` paging by code points. |
| `text.ts` | Removes ANSI/OSC sequences, control chars, bidi and zero-width chars. |
| `tree.ts` | Pure `renderTree` (header counts, pills with 256-color bg, `⧗` deps, 6-line limit, width fit). |
| `widget.ts` | `TreeWidget` component, refresh on change + 1 s poll. |
| `commands.ts` | `ctrl+shift+t` toggle, `/tau`, `/tau show <id>` (scrollable `TextView`). |
| `badge.ts` | `🟢 Herdr` / `🔴 Herdr unavailable`. |
| `tasks/model.ts` | Types, hierarchical IDs, `applyEvent`/`recordEvent` (event sourcing with a list `revision` and event `seq`), `rollback(list, revision)`, agent records, limits (500 tasks, 100 notes, 1000 non-close events). |
| `tasks/rules.ts` | State machine: create/update/claim (claim stack)/complete/fail/cancel (cascade)/note, `delegateTask`, `failTasksOfAgent` (returns `{failed, blocked}`), agent record helpers, cycle check through sub-tasks. |
| `tasks/codec.ts` | Strict decode of the stored JSON (shape, relations, revisions 1..N, replay equals fields, limits). |
| `tasks/store.ts` | SQLite (`node:sqlite`) per list: `<parent of PI_CODING_AGENT_DIR>/tau/tasklists/<lead-session-id>.db`. `BEGIN IMMEDIATE` per change with async retry (no event-loop block). Read cache by `PRAGMA data_version`, reopen when the file identity changes. 0700 dir, 0600 files, no symlinks. |
| `tasks/types.ts` | Default task types with `readOnly` (research, review). |

Tests: `node --test 'src/**/*.test.ts'`. Fakes: `FakeHerdr` in
`delegate.test.ts`, fake `pi` Proxy in `index.test.ts`, fake exec in
`herdr-client.test.ts`.

## 6. Live testing in herdr (you do it yourself)

```sh
cd ~/Development/RomainMuller/tau
P=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['pane']['pane_id'])")
sleep 3   # the new shell needs time, or agent start fails with agent_pane_busy
herdr agent start tau-lead --kind pi --pane $P --timeout 60000 -- -e ./src/index.ts
herdr agent prompt tau-lead '…test instructions…' --wait --timeout 240000
herdr agent read tau-lead --source recent-unwrapped --lines 80
herdr agent list      # check names, status, title, tokens
herdr agent prompt tau-lead "/quit"; sleep 3; herdr pane close $P
```

- For sub-agents in tests, use a cheap model:
  `ai-gw-anthropic-1m/anthropic/claude-sonnet-5`, thinking `low`.
- `pi --no-extensions` breaks the AI gateway provider (the extension that sets
  `PI_CLIENT_SESSION_ID` does not load). Do not use it, or set that variable.
- Only close panes that you made.
- Task lists of live tests are in `~/.pi/tau/tasklists/*.db`. Read one with
  `sqlite3 -readonly <file> "select json from tasklist"`.

## 7. Important decisions (with the reason)

- Storage is SQLite, not JSON + lock file: a lock file cannot remove a
  stale-lock race; SQLite uses an OS lock that ends with the process.
- `HERDR_BIN_PATH` is required (no PATH fallback): security.
- Task IDs are hierarchical (`T1.2.3`), roots start at `T0`, children at `.1`.
- Task type cannot change after the claim (it selects the gate rules).
- Delegation is not work: a busy agent can delegate. Only the owner of an
  in-progress parent can delegate its sub-tasks.
- An agent cannot give a task back: it fails it with `retryable`.
- Romain chose: no type column in the tree; sibling split, auto-close;
  storage `~/.pi/tau` derived from the pi agent dir; tree cap 6 lines;
  global config only; `failed` + retryable for aborts; `tau_wait` returns
  early on a failure; read-only flag for research/review; tree-scoped
  messages with steer/info priority; notes on tasks; ✉ badge in the tree.
- tau replaces Romain's old task-list extension (he removed it). No
  detection of other task extensions (his choice).

## 8. What is left (from README), in the proposed order

1. **Step 6 — "do not stop" rule + `tau_ask_user`** (next; about 1.5–2 h with
   review). Lead cannot stop while tasks are waiting/in progress; sub-agent
   cannot stop while its task is in progress. Continuation message lists
   ready tasks and says to use `tau_wait`. Stop after 3 continuations with no
   task change and notify. `tau_ask_user` = last resort: ends the turn, next
   prompt is the answer, the rule does not apply to that stop. pi hooks:
   `agent_before_settle` (can request one continuation), see
   `docs/extensions.md`. System prompt tells agents to use an "ask question"
   tool instead of ending the turn.
2. **`tau_abort`**: stop a sub-agent (and all its sub-agents), fail their
   tasks `aborted by @x: reason`, retryable. Allowed for own sub-agents at
   any depth. Use agent records (parent chain) and the safe pane close.
3. **Messages and notes**: `tau_send` (tree-scoped: descendants, parent,
   siblings; priority `steer` via `pi.sendMessage` deliverAs `steer`, `info`
   at the next tau call or turn end), inbox per agent, messages stop
   `tau_wait`, `✉n` in the tree. Notes exist already (`tau_note`).
4. **Configuration** `~/.pi/tau/config.json`: `toggleCompletedKey`, `idPills`,
   `maxTreeLines`, `maxParallelSubAgents`, `maxIdleContinuations`,
   `taskTypes` (with `readOnly`). Code already accepts most of these as
   options (`TreeWidgetOptions`, `maxAgents`, `taskTypes`).
5. **Fork**: on `session_start` with reason `fork`, copy the list rolled back
   to the fork point (`rollback` by revision exists; need to map the fork
   entry to a revision, for example with `pi.appendEntry` after each change),
   new session ID, in-progress tasks of other-session owners → failed
   `owner is in a different session`.

## 9. Known limits and open items

- A pane move before a sub-agent's pi starts makes that sub-agent register
  nothing; its task fails after the 2-minute grace.
- Identity checks are cooperative (same user can edit env and DB).
- `createdPanes` is in memory: after a lead restart, empty panes of old
  sub-agents are not closed automatically.
- Ended agent records stay (max 1000 per list).
- No real pi pipeline test (tests call tool `execute` directly). Live tests
  cover the main paths.
- Metadata tokens: cleared at shutdown (title, label, `tau_*` tokens).
