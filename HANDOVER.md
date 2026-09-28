# tau — hand-over for a new session

Read this file first, then `README.md` (the target spec). This file tells
what is done, how the code is organized, how we work, and what comes next.

## 1. First action for the new session

1. Run `npm run check` in `~/Development/RomainMuller/tau` (typecheck + 457
   tests, about 15 s). All must pass.
2. Run `jj log -r '::@' --limit 10` to see the commits below.
3. All README steps are built (section 8). Ask Romain what comes next (for
   example: a live test pass of the open gaps in section 9, a README clean-up
   from DRAFT, or publishing).

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
| `lklwxowt` | `dc93e269` | docs: add a hand-over document for the next session       |
| `tmrzoyxo` | `2676a1d7` | feat: add the do-not-stop rule and tau_ask_user           |
| `xnnzlppn` | `95d5be63` | feat: add tau_abort to stop sub-agents                    |
| `tvkpmnvr` | `4ed71080` | feat: add agent messages with tau_send                    |
| `ytlvsqzr` | `59bbee67` | feat: read the tau configuration file                     |
| `stysslnx` | (see log)  | feat: copy the task list at a session fork                |

The working copy after that is empty.

## 5. Code map (`src/`)

| File | Does |
|------|------|
| `index.ts` | Extension entry. `session_start`: herdr check → identity → open store → register tools, gate, stop rule, commands, widget, supervisor → report pane metadata. `session_shutdown`: stop timers, close store, clear metadata. `createTau(pi, deps)` for tests (returns a `TauHandle`). |
| `herdr.ts` | `detectHerdr`: needs `HERDR_ENV=1`, absolute `HERDR_BIN_PATH` (no PATH search), and `herdr pane current --current` with a pane ID. |
| `herdr-client.ts` | Wrapper for herdr CLI: split, start pi (retries `agent_pane_busy`), prompt, list agents (with pi session), list/close panes, report/clear metadata. `HerdrError.herdrCode`. |
| `identity.ts` | Lead vs sub-agent. Sub-agent env: `TAU_TASKLIST`, `TAU_TASK_ID`, `TAU_AGENT_NAME`, `TAU_PARENT_AGENT`. `checkSubAgent` needs record name/task/parent/pane to agree. Cooperative, not a security boundary. |
| `delegate.ts` | `delegate()`: reserve (claim for the new agent name), split pane with env, record pane, `herdr agent start … -- --model --thinking --extension <tau>`, mark running, first prompt, then a check that the agent did not end (an abort; a fast completion by the same agent is a correct start). Cleanup on failure: keeps an abort result, reports the real task status, and closes the new pane only with proof (`closeNewPane`), else `closeLater` with the session. |
| `supervisor.ts` | Liveness every 5 s for the children of this agent. Knows a child by its pi session (name+pane only in the 2-min start grace). Dead child → fail tasks of it and its descendants (`owner agent exited`). Finished child (task closed, no live sub-agents, idle or 2 min after the close) → end. Safe pane close rule: an occupied pane needs name + session; an empty pane must be one this process made; a moved agent (found by name + session) gets its current pane closed; the request stays when the agent moved between the two herdr lists. `checkAgain()` (a fresh check after the running one), `closeOutcome(pane)` (`closed`/`pending`/`kept`). Dry run on a copy, so no write without a change. |
| `names.ts` | Agent names `tau-t2-1`, `-2` suffix for retries, hash names for deep IDs. |
| `tools.ts` | 14 tools: `tau_list/get/create/update/claim/complete/fail/cancel/note/delegate/wait/send/abort/ask_user`. `tau_send` checks the recipient (`messages.ts`) and the quoted size; `tau_wait` returns when the inbox has a message. `tau_ask_user` returns `terminate: true`. `tau_abort` needs `TaskSession.stopAgents` (else it fails and changes nothing), and reports panes that are `pending` or `kept`. All `executionMode: "sequential"`. Identity from the process, never from args. `conflictingTools` (another extension with a tau name → tau registers nothing). |
| `stop.ts` | "Do not stop" rule. `openWork` (lead: all open tasks; sub-agent: its scope while its task is in progress), `continuationText` (task IDs, statuses, and tau-made agent names only: no agent text, because it is a user-role message; never a `tau_wait` for own tasks), `promptSection` (the `<tau>` system prompt section), `StopGuard` (idle count by list `revision`, give up after 3, ask exemption). |
| `messages.ts` | Messages: `checkRecipient` (sub-agents at any depth, parent, siblings; ended agents refused), `checkMessageText`, `messagesText` (header + `\| ` quote, `cleanText`). |
| `inbox.ts` | `Inbox`: delivers only while the agent is idle (`pi.sendMessage` with `triggerTurn`), at most one turn per 5 s, `pause`/`resume`, gives messages back (`untakeMessages`) when the state changed or the delivery threw, `stop`/`drain`. |
| `fork.ts` | Fork copy: `REVISION_ENTRY` custom entries (written by `index.ts` `registerRevisionRecord` in `message_end` of each message and in `session_before_compact`, lead only), `forkRevision(branch)`, `forkTaskList` (rollback; sub-agent tasks failed `owner is in a different session`, their waiting sub-tasks canceled; records ended), `sessionIdOf(file)`. `index.ts` `forkedList` checks the header ID, the stored `sessionId`, the revision range 1..N, and the copy size; else a warning and a new list. |
| `config.ts` | `~/.pi/tau/config.json` (JSON with comments): `loadConfig` (never throws; O_NONBLOCK open + fstat + bounded read; symlink allowed), `parseConfig` (per-field defaults + problem lines, max 20; `Object.hasOwn`), `isKeyId` (needs ctrl/alt/super; no Escape, `+`, `[ ] \\`, ctrl+h/i/j/m), `configFor` (lead: the file; sub-agent: `TAU_CONFIG` or `fatal`). |
| `gate.ts` | Work gate on `tool_call`: no active task → block non-tau tools; read-only type (or unknown type) → block `edit`/`write`. |
| `format.ts` | Model-facing text. Agent text is quoted with `| ` and labeled as data. `tau_get` previews (2000 chars, last 10 notes/events) and `section`+`offset` paging by code points. |
| `text.ts` | Removes ANSI/OSC sequences, control chars, bidi and zero-width chars. |
| `tree.ts` | Pure `renderTree` (header counts, pills with 256-color bg, `⧗` deps, 6-line limit, width fit). |
| `widget.ts` | `TreeWidget` component, refresh on change + 1 s poll. |
| `commands.ts` | `ctrl+shift+t` toggle, `/tau`, `/tau show <id>` (scrollable `TextView`). |
| `badge.ts` | `🟢 Herdr` / `🔴 Herdr unavailable`. |
| `tasks/model.ts` | Types, hierarchical IDs, `applyEvent`/`recordEvent` (event sourcing with a list `revision` and event `seq`), `rollback(list, revision)`, agent records, limits (500 tasks, 100 notes, 1000 non-close events). |
| `tasks/rules.ts` | State machine: create/update/claim (claim stack)/complete/fail/cancel (cascade)/note, `delegateTask`, `failTasksOfAgent` (returns `{failed, blocked}`), `abortTask` (permission by `isAgentUnder`, fails tasks of the owner and its live descendants, deepest first, then ends their records), agent record helpers, cycle check through sub-tasks. An ended agent cannot change tasks (notes are permitted). |
| `tasks/codec.ts` | Strict decode of the stored JSON (shape, relations, revisions 1..N, replay equals fields, limits, agent parents make a tree under the lead with no cycle). |
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

## 8. What is left (from README)

Nothing: all planned README features are built. The README header still
says "Status: DRAFT".

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
- Stop rule hooks (in `index.ts` `registerStopRule`): `input` (source not
  `extension`) resets the guard; `turn_end` sets the ask exemption only when
  the turn had one tool result, a successful `tau_ask_user`; `before_agent_start`
  sets the `<tau>` section; `agent_before_settle` adds a `tau-continue`
  custom message and `continue: true`, or warns (give up, or list not
  readable). No rule on `aborted`/`error` outcomes, or when another
  extension continues.
- The guard state is in memory: a pi restart starts the idle count again.
- A mixed batch with `tau_ask_user` is unit-tested only: in live tests the
  model follows the description and calls it alone.
- `tau_abort` limits (accepted, documented in README):
  - An empty pane of a grandchild that exited before the abort stays open:
    only the process that made a pane can close it empty, and that process
    is stopped too.
  - An abort while a descendant splits a pane (before it records the pane
    ID) can leave that new pane open.
  - A task that stays in progress (open sub-tasks) later fails with `owner
    agent exited`, not with the abort reason.
  - A `kept` pane (no proof of its occupant) is not retried: `tau_abort`
    tells the model to ask the user to check it.
  - The pane rule is not a security boundary: a same-user program that
    writes a false name and session in the list can make tau close a pane.
- Messages (decisions and limits):
  - Stored in a `messages` table in the task-list database (not jsonl inbox
    files): SQLite locks, and a shared read state for `✉n`. `store.ts`:
    `sendMessage` (limit 100 unread per recipient; removes unread messages
    of ended agents; keeps 2000 older read messages + the last minute),
    `takeMessages` (at most 40000 formatted chars per take), `untakeMessages`,
    `unreadCounts` (cached by `data_version`).
  - Delivery while working only at points that pi writes into the session:
    `tool_result` (steer for every tool, all for `tau_*`; not for a
    successful `tau_ask_user`) and `agent_before_settle` (before the stop
    rule; at most 5 message continuations between user inputs). The inbox
    pauses after a run that did not settle normally, and while a question
    waits; user input resumes it. pi emits no abort event: an Esc is found
    when no settle boundary completed after the last turn, or when the last
    boundary asked to continue and no `turn_start` came
    (`registerContinuationTracker`, registered after the stop rule). An Esc
    at a boundary that does not continue cannot be seen (README limit).
  - Accepted limits (README "Limits"): tool calls that pi does not run give
    no messages; another extension can replace a tool result after tau
    added messages; an async failure of `pi.sendMessage(triggerTurn)` is not
    reported to tau; mixed tau versions (restart sub-agents after an
    upgrade).
- Configuration: the lead reads the file at session start (and `/reload`);
  it gives `JSON.stringify(config)` to each sub-agent in `TAU_CONFIG` (herdr
  `--env`, visible in process arguments: no secrets). A sub-agent with no
  valid `TAU_CONFIG` fails closed (`failClosed` in `index.ts`: error, a
  handler that blocks all tools, `ctx.shutdown()`); the same for a sub-agent
  without herdr, with a tool-name conflict, or with a failed identity check.
  Its parent fails the task after the start grace and closes the empty pane. After `/reload`, running sub-agents keep their
  old configuration (README limit). `/tau` with `idPills: false` has no
  command test. A sub-agent with a different `PI_CODING_AGENT_DIR` than its
  lead is refused by the identity check (pre-existing).
- Fork (decisions and limits): the fork point is the last `tau-revision`
  entry in the new branch (pi copies the branch). No entry (older sessions),
  a revision outside 1..N, a list of a different session, a read error, or a
  copy over 16 MiB -> warning + new list; no old list -> new list, no
  warning. Only saved sessions (pi gives `previousSessionFile` then). A
  custom message of another extension while the lead is idle does not
  trigger a record (README limit). A lead-owned task under a sub-agent task
  keeps that task (and waiting tasks between) open until the lead closes or
  cancels them (rule 11). The size fallback has no test (needs a ~16 MiB
  list). Not live-tested: fork with a running sub-agent, fork of a fork,
  `/clone`.
- Shutdown stops the tree, the supervisor, and the inbox (after `stop()`,
  they start no new work: `check`, `checkAgain`, `refresh` do nothing), waits
  for the inbox poll and the supervisor check, then for the tree refresh, and
  then closes the store.
- Not tested: `index.ts` passes the session to `closeLater` (one line, no
  end-to-end test); the `checkAgain` concurrency test uses the test copy of
  the stop hook, not the `index.ts` one.
