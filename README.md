# tau

`tau` is a [pi](https://github.com/earendil-works/pi) extension for one
workflow: a lead agent plans work as a task list, then does the tasks or
delegates them to sub-agents that run in [herdr](https://herdr.dev) panes.
While work is open, `tau` tells each agent to continue (see
[The "do not stop" rule](#the-do-not-stop-rule) for the exceptions).

## Contents

1. [Quick start](#quick-start)
2. [Herdr detection](#herdr-detection)
3. [The task list](#the-task-list)
4. [Task lifecycle](#task-lifecycle)
5. [Sub-tasks](#sub-tasks)
6. [Delegation to sub-agents](#delegation-to-sub-agents)
7. [The "do not stop" rule](#the-do-not-stop-rule)
8. [Messages and notes](#messages-and-notes)
9. [Tools](#tools)
10. [Commands and keys](#commands-and-keys)
11. [Storage](#storage)
12. [Configuration](#configuration)

---

## Quick start

1. Install the extension:

   ```sh
   pi install git:github.com/RomainMuller/tau
   ```

2. Start pi inside a herdr pane:

   ```sh
   herdr   # then, in a pane:
   pi
   ```

3. Type a prompt. The agent first plans a task list, then does the work.

---

## Herdr detection

When pi starts, `tau` checks if herdr controls the current pane. The check
passes when **all** conditions are true:

- The environment variable `HERDR_ENV` is `1`.
- The environment variable `HERDR_BIN_PATH` is an absolute path. Herdr sets
  it to the path of its binary.
- The command `herdr pane current --current` succeeds, and its reply
  identifies a pane (the reply has a pane ID).

`tau` runs only the herdr binary at `HERDR_BIN_PATH`. It does not search
`PATH`, because a different `herdr` program in `PATH` can run with the
permissions of pi.

The result shows as a badge above the prompt box.

**Herdr is available:**

```text
🟢 Herdr
╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
```

**Herdr is not available:**

```text
🔴 Herdr unavailable
╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
```

When herdr is not available, `tau` does nothing else in a lead. It registers
no tools, no commands, and no keys. Its only hooks are the `session_start`
handler, which does the check and shows the badge, and the
`session_shutdown` handler, which removes the badge. Pi runs in its standard
mode. The badge is the only difference. (A tau sub-agent without herdr
blocks all work and stops: see
[The identity of a sub-agent](#the-identity-of-a-sub-agent).)

Also when herdr is available, a lead can run in the standard mode: when
`tau` cannot open the task list, or when a different extension has a tool
with a `tau_*` name. Then `tau` shows an error, and registers no tools and no
work gate.

`tau` does the check one time, in the first `session_start` event. The result
stays the same until pi reloads the extension (`/reload`).

---

## The task list

Each lead session has one task list. Its sub-agents use the same list. When
a lead session starts and has no task list, `tau` creates one with a single
task (a [fork](#fork) can get a copy of the list of its old session):

```text
T0    in_progress  Prepare task list    @lead
```

This task tells the agent to read the user prompt, plan the work, and create the
tasks it needs. The lead owns `T0` from the start: it does not claim it. While
`T0` is open, the lead can claim only sub-tasks of `T0`. To work on a different
root task, the lead closes `T0` first.

### Task fields

| Field          | Required | Changes allowed                                     |
|----------------|----------|-----------------------------------------------------|
| `id`           | yes      | Never. See [Task IDs](#task-ids).                   |
| `title`        | yes      | Short and descriptive.                              |
| `type`         | yes      | One of the [task types](#task-types).               |
| `description`  | no       | Markdown. Can be long.                              |
| `dependencies` | yes      | List of task `id`s (can be empty). Only while `waiting`. |
| `status`       | yes      | See [Task lifecycle](#task-lifecycle).              |
| `owner`        | no       | The agent that claimed the task.                    |
| `result`       | no       | Markdown. Set when the task closes.                 |
| `retryable`    | no       | Set when the task fails. See [Rules](#rules).       |
| `notes`        | yes      | Shared findings (can be empty). See [Notes](#notes). |
| `history`      | yes      | Each change, with time and agent. See [Fork](#fork).|

### Task IDs

The `id` shows the position of the task in the tree:

| ID       | Meaning                                                |
|----------|--------------------------------------------------------|
| `T0`     | The first root task.                                   |
| `T3`     | The fourth root task.                                  |
| `T1.2`   | The second sub-task of `T1`.                           |
| `T1.2.3` | The third sub-task of `T1.2`.                          |

Each parent has its own sequence for its sub-tasks. The parent of a task is
the `id` without its last part: the parent of `T1.2.3` is `T1.2`.

### Task types

`tau` has these types by default. You can set a different list in the
[configuration](#configuration): it replaces the default list, and it must
have `plan`.

| Type       | Read-only | Use it for                                                  |
|------------|-----------|-------------------------------------------------------------|
| `plan`     | no        | Make or change the task list. See [Plan tasks](#plan-tasks).|
| `research` | yes       | Read code, docs, or the web. No file changes.               |
| `code`     | no        | Change code or files.                                       |
| `test`     | no        | Write or run tests.                                         |
| `review`   | yes       | Read-only check of work done by other tasks.                |
| `docs`     | no        | Write documentation.                                        |

For a read-only type, the [work gate](#work-gate) blocks `edit` and `write`.

#### Plan tasks

A `plan` task can make more than the task list. For example, it can write a
Markdown plan and get your approval for it. In this case, the agent creates a
sub-task for each deliverable (a part of the tree, without the header):

```text
○ T0    Prepare task list
├─ ○ T0.1  Write plan in docs/plan.md
└─ ○ T0.2  Get user approval for the plan        ⧗ T0.1
```

### The task tree widget

The task list shows as a tree under the herdr badge. The tree starts below
the 🟢 badge.

By default, task IDs show as [colored pills](#colored-id-pills). The previews
in this section show the status marks instead (the `idPills: false` option),
because a text preview cannot show colors.

**Default view.** `completed` and `canceled` tasks are hidden. The sub-tasks
of a `completed` task are hidden too, also the `failed` ones. A `canceled` task
shows only when one of its sub-tasks shows. `⧗` shows only on `waiting` tasks, and only the
dependencies that are not complete.

```text
🟢 Herdr ─ 2 waiting · 2 running · 2 done · 1 failed · 1 canceled
├─ ◐ T2    Add magic-link login endpoint         @lead
│  ├─ ◐ T2.1  Create login_tokens table          @tau-t2-1
│  └─ ○ T2.2  Write endpoint tests               ⧗ T2.1
├─ ○ T3    Update login page                     ⧗ T2
└─ ✖ T4    Security review of token storage      @tau-t4 · owner agent exited
╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
```

**All tasks view** (after `ctrl+shift+t`, the default
[key](#configuration)). `⧗` shows all dependencies. A
dependency that is complete has a `✔` (with pills, the green pill shows it).
The line limit of [Tall trees](#tall-trees) applies to this view too: this
preview shows 8 lines, as with `maxTreeLines: 8`.

```text
🟢 Herdr ─ 2 waiting · 2 running · 2 done · 1 failed · 1 canceled
├─ ✔ T0    Prepare task list                     @lead
├─ ✔ T1    Map the current login flow            @tau-t1
├─ ◐ T2    Add magic-link login endpoint         @lead         ⧗ T1✔
│  ├─ ◐ T2.1  Create login_tokens table          @tau-t2-1     ⧗ T1✔
│  └─ ○ T2.2  Write endpoint tests               ⧗ T1✔ T2.1
├─ ○ T3    Update login page                     ⧗ T2
├─ ✖ T4    Security review of token storage      @tau-t4 · owner agent exited
└─ ⊘ T5    Add SMS login                         canceled
```

The header shows one count for each status. A count of 0 does not show.

Legend:

| Mark | Meaning                                          |
|------|--------------------------------------------------|
| `○`  | `waiting`                                        |
| `◐`  | `in_progress`                                    |
| `✔`  | `completed`                                      |
| `✖`  | `failed`                                         |
| `⊘`  | `canceled`                                       |
| `@x` | Agent `x` owns the task.                         |
| `⧗`  | The task depends on these tasks.                 |
| `✉n` | The owner has `n` messages that it did not read. (For an agent with no active task, `@agent ✉n` shows in the header.) |
| `⚠ error` | The owner (a sub-agent) stopped after an error, and waits for a message. See [Errors of a sub-agent](#errors-of-a-sub-agent). |

Example with messages that are not read yet:

```text
🟢 Herdr ─ 1 waiting · 3 running · 3 done
├─ ◐ T2    Add magic-link login endpoint         @lead ✉1
│  ├─ ◐ T2.1  Create login_tokens table          @tau-t2-1 ✉2
│  └─ ◐ T2.3  Add token cleanup job              @tau-t2-3
└─ ○ T3    Update login page                     ⧗ T2
```

#### Colored ID pills

By default, `tau` shows each task ID as a colored pill, made with powerline
characters. The color shows the status, so the status mark is not necessary.
This option needs a [Nerd Font](https://www.nerdfonts.com). You can turn it off
in the [configuration](#configuration).

```text
🟢 Herdr ─ 2 waiting · 2 running · 2 done · 1 failed
├─ T2    Add magic-link login endpoint       @lead
│  ├─ T2.1  Create login_tokens table        @tau-t2-1
│  └─ T2.2  Write endpoint tests             ⧗ T2.1
├─ T3    Update login page                   ⧗ T2
└─ T4    Security review of token storage    @tau-t4 · owner agent exited
```

| Status        | Pill color                  |
|---------------|-----------------------------|
| `waiting`     | gray                        |
| `in_progress` | blue                        |
| `completed`   | green                       |
| `failed`      | red                         |
| `canceled`    | orange, with strikethrough  |

#### Tall trees

The tree shows at most 6 task lines. When there are more tasks, the last line
tells how many tasks are not shown. You can change the limit in the
[configuration](#configuration).

```text
🟢 Herdr ─ 9 waiting · 3 running · 1 failed
├─ ◐ T2    Add magic-link login endpoint         @lead
│  ├─ ◐ T2.1  Create login_tokens table          @tau-t2-1
│  └─ ○ T2.2  Write endpoint tests               ⧗ T2.1
├─ ○ T3    Update login page                     ⧗ T2
├─ ✖ T4    Security review of token storage      @tau-t4 · owner agent exited
├─ ◐ T6    Add rate limit to login               @tau-t6
└─ … 7 more (/tau to see all)
```

---

## Task lifecycle

```text
                claim (deps all completed)
  ┌─────────┐ ────────────────────────────▶ ┌─────────────┐
  │ waiting │                               │ in_progress │ ◀──────┐
  └─────────┘                               └─────────────┘        │
       │                          complete │         │ fail        │
cancel │                                   │         │ owner gone  │ claim
       │                                   │         │ abort       │ (retry)
       ▼                                   ▼         ▼             │
  ┌──────────┐                   ┌───────────┐   ┌────────┐        │
  │ canceled │                   │ completed │   │ failed │ ───────┘
  └──────────┘                   └───────────┘   └────────┘
```

### Rules

1. A new task has the status `waiting`.
2. An agent can **claim** a task when all these conditions are true:
   - The status is `waiting`, or `failed` with `retryable: true`.
   - Each dependency has the status `completed`.
   - The agent owns no `in_progress` task, **or** the task is a sub-task (at
     any depth) of the task that the agent works on now.
3. An agent works on **one** task at a time: its _active_ task. When an agent
   claims a sub-task of its active task, the sub-task becomes the active task.
   When the sub-task closes, the parent becomes the active task again.
4. An agent must own a task before it can do work. Until then, `tau` blocks all
   tools except the `tau_*` tools (and the `askTool`, if you set one). See
   [Work gate](#work-gate).
5. Only the owner can **complete** or **fail** a task. The owner must give a
   `result`.
6. An agent cannot give a task back. If it cannot do the task, it fails the
   task. The `result` tells why, and `retryable: true` tells that a different
   agent can try again.
7. A parent task can close only when each sub-task is `completed`, `failed`, or
   `canceled`.
8. An agent that can change a `waiting` task can **cancel** it. A reason is
   necessary. `tau` also cancels the `waiting` sub-tasks of the task. If a
   sub-task is `in_progress`, the cancel fails.
9. Dependencies can change only while the task is `waiting`. A task cannot
   depend on itself, on its parent tasks, or on a task that waits for it (a
   cycle). A task waits for its dependencies, and for its sub-tasks (it can
   close only after them).
10. After a claim, only the owner can change the `title`, the
    `description`, and the `status`. Nobody can change the `type` after the
    claim, because the type selects the rules of the work gate.
11. When the owner agent stops existing, `tau` sets the task to `failed` with
    the result `owner agent exited` and `retryable: true`. See
    [Liveness](#liveness). If the task has sub-tasks that are not closed, the
    task stays `in_progress` until they close (rule 7): the lead can claim,
    finish, or cancel them. Then `tau` fails the task.
12. A `failed` task with `retryable: true` can be claimed or delegated again
    (rule 2). Usually the lead decides this: it coordinates the work.

An agent can **change** a task when it is the lead, or when the task is in
the task that the agent received from its parent (the task or one of its
sub-tasks). All agents can **see** all tasks, and can add
[notes](#notes) to all tasks.

### Claim stack example

```text
@lead claims T2            active: T2
@lead claims T2.3          active: T2.3   (T2 stays in_progress, owned by @lead)
@lead completes T2.3       active: T2
@lead completes T2         active: none
```

### Abort

An agent can **abort** a task that a sub-agent owns, with `tau_abort`. It can
abort a task when the sub-agent is one of these:

- A sub-agent that it started.
- A sub-agent that one of its sub-agents started, at any depth.

When a task is aborted:

1. `tau` stops the sub-agent and closes its pane.
2. `tau` also aborts all sub-agents that the stopped sub-agent started.
3. Each task that a stopped agent owned becomes `failed`, with the result
   `aborted by @<agent>: <reason>`.

An aborted task has no special status. It is `failed`, with
`retryable: true`. The lead can retry it.

An agent cannot abort its own task: it uses `tau_fail`. It cannot abort a
sub-agent that ended already. If a task of a stopped agent has sub-tasks
that are not closed (for example, `waiting` sub-tasks), the task stays
`in_progress` (rule 7). When its sub-tasks close, the liveness check fails
it with the result `owner agent exited`. If you abort a sub-agent while it
starts, `tau` stops the start and closes the new pane.

`tau` closes a pane only when this is safe (see [Liveness](#liveness)). So
in rare cases a pane stays open: for example, when a sub-agent of a stopped
sub-agent exited before the abort, its empty pane stays open, because the
agent that made the pane is stopped too. `tau_abort` tells you about each
pane that it did not close:

- When herdr did not reply, or the close failed, `tau` tries again at each
  liveness check.
- When `tau` cannot prove that the stopped agent is in the pane, it does not
  close the pane, and it does not try again. Check the pane yourself.

A rare case: if an agent aborts a sub-agent while that sub-agent splits a
pane for its own new sub-agent, the new pane can stay open.

### Liveness

Each agent watches the sub-agents that it started. It runs `herdr agent list`
every 5 seconds (only when it has sub-agents). When a sub-agent starts, it
records its pi session in its agent record. `tau` knows a sub-agent in the
herdr list by this pi session, which stays the same when the pane moves or
when a different agent gets the same name. (While a sub-agent starts, `tau`
uses its name and its pane.) When a sub-agent is not in the list, `tau` fails
its task (rule 11), and closes its pane. `tau` does the same for the
sub-agents of that sub-agent, at all depths, because nobody watches them
now. A sub-agent that is still starting has 2
minutes before `tau` checks it. When you move the pane of a sub-agent, `tau`
records its new pane (herdr gives a moved pane a new ID). This is also
correct when the pane moves before the pi of the sub-agent starts: then the
sub-agent records its new pane when it starts.

A sub-agent that stopped after an error is alive while its pi runs (herdr
shows it): the liveness check does not fail its task (see
[Errors of a sub-agent](#errors-of-a-sub-agent)).

A sub-agent ends when its task is closed, it has no live sub-agents, and it
is idle. If it is not idle 2 minutes after its task closed, it ends too. An
ended sub-agent cannot change tasks (it can still add notes).

`tau` closes the pane of an ended sub-agent only when herdr shows that
sub-agent in the pane, or when this pi made the pane and no agent is in
it. herdr shows the sub-agent when it shows an agent with the pi session
that the sub-agent recorded when it started, and one of these is true:

- The agent has the name of the sub-agent.
- The agent has no name, and this pi made the pane. (herdr can drop the
  name of an agent when its start times out. A pi that you started has no
  herdr name too: so a nameless agent in a different pane is not proof.)

When the sub-agent moved (herdr shows it with its name and pi session in a
different pane), `tau` closes its current pane. So an old record cannot close a different pane, for example
yours. (This is not a security boundary: a program of your user that writes
false records in the task list can make `tau` close a pane.) When a close fails, `tau` tries again at the next check.
A limit: `tau` keeps these close requests in the memory of the pi process.
When the lead stops before a close succeeds, the pane stays open after
the lead starts again: close it yourself.

The lead can also stop existing (for example, you close its pane). When you
resume the lead session, its liveness check compares its sub-agents with
`herdr agent list`. Each `in_progress` task of a sub-agent that does not
exist becomes `failed`, with the result `owner agent exited` and
`retryable: true`. A task of the lead stays `in_progress`: the lead works on
it again.

### Work gate

If an agent calls a tool that is not a `tau_*` tool (or the
[`askTool`](#set-the-ask-tool-asktool)), and it owns no `in_progress` task,
`tau` blocks the call:

```text
✖ bash
  tau blocked bash: you have no active task. All work must be for a task that you own.
  1. Find the task that this work is for (tau_list), and claim it (tau_claim).
  2. If no task is correct, create one (tau_create), then claim it.
  Do only the work that the active task needs.
```

If `tau` cannot read the task list, it blocks the call too, and tells why.
When the record of a sub-agent ended (for example, an agent aborted it),
`tau` blocks all its tools except the `tau_*` tools (and the `askTool`),
also when its task stays `in_progress` because of open sub-tasks.
If the lead cannot open the task list when the session starts, `tau` shows
an error and registers no tools and no gate: pi runs in its standard mode.
(A sub-agent stops: see [The identity of a sub-agent](#the-identity-of-a-sub-agent).)

When the type of the active task has `readOnly: true`, the work gate also
blocks `edit` and `write`. `bash` stays available, because `tau` cannot check
if a command changes files.

```text
✖ edit
  tau blocked edit: your active task T1 has the type "research", which is read-only.
  Record what you found in the task result. Create a "code" task for changes.
```

A task type that the configuration does not define is read-only.

When a batch of tool calls has a `tau_*` tool, pi runs the calls one at a
time. So the work gate checks each call after the `tau_*` calls before it:
for example, `bash` after `tau_complete` in the same batch is blocked.

`tau` uses the names of its tools to know them. If a different extension
registered a tool with the name of a `tau_*` tool first, `tau` shows an
error and registers no tools and no gate.

`tau` cannot check that the work is for the active task. The message and the
system prompt tell the agent to do only that work.

A lead that delegates all tasks owns no task while it waits. This is correct:
it calls only `tau_*` tools.

The work gate never blocks the [ask tool](#questions-to-the-user) that you
set in `askTool` (see [Configuration](#configuration)): an agent with no
active task (for example a lead that waits for its sub-agents) must be able
to ask you a question. The gate blocks all other "ask question" tools while
the agent has no active task.

---

## Sub-tasks

A task can have sub-tasks. The `id` of a sub-task starts with the `id` of its
parent. See [Task IDs](#task-ids).

Who can add a sub-task to task `Tn`:

| Status of `Tn` | Who can add a sub-task          |
|----------------|---------------------------------|
| `waiting`      | Any agent that can change `Tn`. |
| `in_progress`  | Only the owner of `Tn`.         |
| other          | Nobody.                         |

---

## Delegation to sub-agents

Delegation is the normal way to work. The lead plans and coordinates. The
sub-agents do the work.

### How it works

1. The lead calls `tau_delegate` with a task that is ready to claim. It can also
   give a model and a thinking level (see
   [Model and thinking level](#model-and-thinking-level)).
2. `tau` gives the task to a new agent name, for example `tau-t2-1` for
   `T2.1`. The new agent is the task owner, and the status is `in_progress`.
   If the name is used (for example for a retry), `tau` adds a number:
   `tau-t2-1-2`.
3. `tau` makes a new pane in the column of sub-agents (see
   [Pane layout](#pane-layout)), and starts pi in the new pane, with the
   first prompt as a pi argument:
   `herdr agent start tau-t2-1 --kind pi --pane <new-pane> --timeout 60000 -- --model … --thinking … --extension <tau> -- "<first prompt>"`
4. The first prompt tells the sub-agent its task ID, and what to do when
   the work is done. It has no text that agents wrote (for example the
   title): the sub-agent reads its task with `tau_get`.
   - pi sends the prompt to the model after all extensions loaded (also
     `tau`, which checks the identity of the sub-agent first). `tau` does not
     type the prompt into the pane, so no key press can be lost. If `tau`
     does not start correctly in the sub-agent, the prompt does not go to
     the model.
   - Then `tau` waits (at most 10 seconds) until herdr shows that the
     sub-agent works on the prompt.
   - If `herdr agent start` fails, or herdr does not show this, `tau` reads
     the pi session file of the sub-agent (at most 4 MiB). The start is
     correct when herdr shows the new sub-agent with this session file (the
     same path; a session ID alone is not enough), with its name, or with
     no name in its new pane, and the file has the first prompt of this sub-agent, and
     after it an answer or an error of the model. (Then the turn was too
     short for herdr to see it, or herdr timed out while pi worked.) When
     herdr dropped the name of the agent, `tau` tries to give it back
     (`herdr agent rename`). When this fails, the sub-agent still works:
     `tau` knows it by its pi session and its pane, and the liveness check
     tries the rename again. Until then, `tau` cannot follow the sub-agent
     when its pane moves.
   - Else the start fails. For example, pi could not send the prompt to the
     model (no login), and it stays idle.
5. The sub-agent can see the full task list. It can change only its task and
   the sub-tasks of its task.
6. The sub-agent can delegate its own sub-tasks to more sub-agents.
7. When the sub-agent closed its task and is idle, `tau` closes its pane. The
   task `result` keeps the output.

If a step after step 2 fails (for example, pi does not start, or the
sub-agent does not start to work), the task
becomes `failed` with `retryable: true`, and `tau` closes the new pane when
this is safe (see [Liveness](#liveness)). Exceptions: a task that the
sub-agent completed already stays completed (the start is correct), and a
task with open sub-tasks stays `in_progress` until they close (rule 7).

Sub-agents are always pi agents. The new pane is in the tab of the lead (see
[Pane layout](#pane-layout)).
`tau` does not move the focus to the new pane. The sub-agent loads the pi extensions of your pi settings, and tau.
Extensions that you gave to the lead with `-e` only are not loaded.

An agent can delegate a task while it works on a different task: delegation
is not work. When the parent task is `in_progress`, only its owner can
delegate its sub-tasks.

### Pane layout

The lead pane stays on the left, at full height. All sub-agents (also the
sub-agents of sub-agents) go in one column on the right of the lead, and
each pane of the column gets the same height:

```text
1 sub-agent        3 sub-agents
+------+------+    +------+------+
|      |      |    |      | t1   |
|      |      |    |      +------+
| lead |  t1  |    | lead | t2   |
|      |      |    |      +------+
|      |      |    |      | t3   |
+------+------+    +------+------+
```

1. The first sub-agent splits the lead pane to the right. The lead and the
   column get one half of the width each.
2. Each next sub-agent splits the lowest pane of the column down.
3. After a pane of a sub-agent opens or closes (also when you close it),
   `tau` gives the same height to each pane of the column again
   (`herdr pane resize`).

The column is the stack of panes that touch the right edge of the lead
pane. A pane of the column is a `tau` pane when it is the pane of a
sub-agent that did not end, and herdr shows no agent in it, or shows that
sub-agent. `tau` changes the heights only when all panes of the column are
`tau` panes: a pane that you added or use there stays as it is. `tau` does
not split a pane of the column that you split to the right. When the
column has no `tau` pane, the next sub-agent starts a new column at the
right edge of the lead.

`tau` uses the layout only when herdr shows the lead in the lead pane (the
pi session of the task list), and the agent that delegates is in the same
tab. So a wrong `TAU_LEAD_PANE` cannot make `tau` change a different pane.

When `tau` cannot find the lead pane (for example, you moved it to a
different tab), or when the lead does not give its pane (an older version
of `tau`), `tau` splits the pane of the agent that delegates: to the right
for a wide pane, down for a narrow pane. When you move panes by hand,
`tau` does not move them back (it only changes the heights of the
column). The layout is only for display: an
error in it does not stop a delegation.

### The identity of a sub-agent

The new pane gets these environment variables:

| Variable           | Value                                               |
|--------------------|-----------------------------------------------------|
| `TAU_TASKLIST`     | The path of the task list database of the lead.     |
| `TAU_TASK_ID`      | The task of the sub-agent, for example `T2.1`.      |
| `TAU_AGENT_NAME`   | The herdr name of the sub-agent: `tau-t2-1`.        |
| `TAU_PARENT_AGENT` | The agent that started it: `lead` or `tau-…`.       |
| `TAU_CONFIG`       | The configuration of the lead, as JSON. See [Configuration](#configuration). |
| `TAU_LEAD_PANE`    | The herdr pane of the lead, for the [pane layout](#pane-layout). Only for display. |

`tau` does not trust these values alone. The database must be in the tau
directory, and the task list must have a record of this sub-agent, with the
same task, parent, and herdr pane. The task must be `in_progress`, with the
sub-agent as owner. One exception for the pane: when the pane moved before
pi started (herdr gives a moved pane a new ID), the sub-agent can start in
its new pane, if herdr does not show the old pane any more and no pi of this
sub-agent registered yet. Then the sub-agent records its new pane.

A sub-agent that cannot start `tau` correctly must not work: for example,
these checks fail, it has no valid configuration from its lead, it cannot
use herdr, or a different extension has a `tau_*` tool name. Then `tau`
shows an error, blocks all tools, and stops that pi. If pi stops before the
start completes, the delegation fails at once (the task fails, retryable,
and `tau` closes the pane). Else the pane is empty: the parent fails the
task (`owner agent exited`) when the start grace time ends, and closes the
pane.

These checks keep the agents of one user in order. They are not a security
boundary between agents: a program of the same user (for example a `bash`
command of a model) can change the environment and the database.

### What herdr shows

Each tau pi tells herdr what its pane is (`herdr pane report-metadata`):

| Pane      | Title                         | Agent label     | Tokens                                          |
|-----------|-------------------------------|-----------------|-------------------------------------------------|
| lead      | `tau lead`                    | `tau lead`      | `tau_role=lead`, `model=<model>`                |
| sub-agent | `tau-t2-1 · T2.1 <task title>` | `<title label>` | `tau_role=subagent`, `tau_task=T2.1`, `tau_parent=lead`, `model=<model>` |

- The title label is a short form of the task title, for the side bar:
  lower-case words with `-` between them, at most 28 characters. For
  example, "Review: tests and validation" gives
  `review-tests-and-validation`. `tau` keeps only the letters `a` to `z`
  (also without their accents) and the digits. When the title has none of
  them, the label is `tau sub-agent`.
- `<model>` is the name of the model of the agent (for example
  `GPT-6 Sol`), else its ID. When you select a different model, `tau`
  reports it again. When pi does not know the model, `tau` removes the
  `model` token.

The herdr side bar shows the agent label as `agent`. To also show the
model, add the `$model` token to the rows of the side bar, in the herdr
`config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "$model"],
]
```

herdr knows each sub-agent by its name (`herdr agent list`), and the herdr
pi integration reports its state (`working`, `idle`, `blocked`). The badge of
a sub-agent tells its name and its task: `🟢 Herdr @tau-t2-1 (T2.1)`. When pi
stops, `tau` removes its metadata from the pane that it recorded when pi
started. (After a pane move, the metadata can stay on the moved pane.)

At most 4 sub-agents exist at the same time, for the full task list (all
agent records that did not end, also the ones that start now). You can
change this limit in the [configuration](#configuration). When the limit is
reached, `tau_delegate` fails with a message that tells the agent to use
`tau_wait`.

```text
┌─ lead (w1:p1) ────────────────────┬─ tau-t2-1 (w1:p2) ───────────────┐
│ ● tau_delegate T2.1               │ ◐ T2.1 Create login_tokens table │
│   model: <from routing rules>     │                                  │
│   thinking: medium                │ ● read src/db/schema.ts          │
│ ✔ Started @tau-t2-1 in pane w1:p2 │ ● edit src/db/schema.ts          │
│                                   │                                  │
│ ● tau_wait T2.1, T4               │                                  │
│   waiting…                        │                                  │
├───────────────────────────────────┤                                  │
│ 🟢 Herdr ─ 2 waiting · 2 running  │ 🟢 Herdr @tau-t2-1 (T2.1) ─ 2 wa…│
│ ├─ ◐ T2    Add magic-link…  @lead │ ├─ ◐ T2    Add magic-link…  @lead│
│ │  ├─ ◐ T2.1  Create lo… @tau-t2-1│                                  │
╰───────────────────────────────────┴──────────────────────────────────╯
```

### Model and thinking level

`tau` has no model IDs in its code. The agent that delegates selects the model
and the thinking level from the task `type`. It uses the rules in the
user-wide `AGENTS.md` file or in skills (for example a `model-routing` skill).

The description of the `tau_delegate` tool tells the agent this:

> Before you call this tool, select the model and the thinking level for the
> task type. Use the model routing rules from AGENTS.md or from skills. If no
> rule applies, omit model and thinking: the sub-agent then uses your model
> and thinking level.

When the agent omits the model and `tau` does not know the model of the
agent, `tau_delegate` fails and asks for a model.

---

## The "do not stop" rule

An agent cannot stop while its task list has open work. (Exceptions: you
stop it, or its run ends with an error. See below.)

- **Lead:** it cannot stop while a task in the list is `waiting` or
  `in_progress`.
- **Sub-agent:** it cannot stop while its task is `in_progress` and it owns
  the task. (After a failed start, a retry can give the task to a different
  sub-agent.)

When the agent tries to stop too early, `tau` sends a continuation message
(this example is without an `askTool`; with one, the last line names it):

```text
⟳ tau: 5 tasks are open (T1, T2, T3, T2.1, T2.2). Continue the work. Do not stop before the work is done.
  Your active task: T2. Do its work, then close it with tau_complete or tau_fail.
  Not ready: T1 (@tau-t1), T2.1 (@tau-t2-1), T3 (waits for T2), T2.2 (waits for T2.1).
  Use tau_wait with ids ["T1","T2.1"]. Do not poll.
  If you must have an answer from the user, call an ask question tool (or tau_ask_user if no other one is available). Do not end your turn to ask.
```

When a task is ready, the message tells the agent to claim or delegate it.
The message has only task IDs, statuses, and agent names. It does not have task
titles: the model gets the message as a user message, and text that agents
wrote must not look like an instruction of the user. If `tau` cannot read the
task list, the agent stops, and `tau` shows a warning.

After 3 continuations with no change to the task list, `tau` stops the rule and
notifies you. The rule is off until your next prompt. You can change this
limit in the [configuration](#configuration).

The rule does not apply when you stop the agent (for example with `Esc`), or
when the run ends with an error. A failed task is not open work: the lead
decides if it retries the task.

### Errors of a sub-agent

A run can end with an error, for example when the model provider does not
reply, or when the model does not exist. pi can try again for some errors.
When the run still ends with an error, the sub-agent stops its work, but
its pi process stays active: the liveness check does not fail its task.

So when a run of a sub-agent ends with an error, and its task is still
`in_progress`, `tau` sends a `steer` message from the sub-agent to its
parent at once:

```text
✉ steer from @tau-t2-1 (T2.1). This message is from a different agent, not from the user:
| tau: the run of @tau-t2-1 ended with an error, and pi does not try again. Its task T2.1 stays in progress, and @tau-t2-1 waits.
| To continue, send @tau-t2-1 a message with tau_send (for example "continue"): the message starts a new turn.
| To stop it, use tau_abort for T2.1, then delegate T2.1 again if necessary.
| The kind of error: timeout.
```

The message tells only the kind of error (for example `timeout`, `rate
limit (HTTP 429)`, or `not found (…) (HTTP 404)`), not the text of the
error: that text comes from the model provider, and it can contain
instructions or tokens. The pane of the sub-agent shows the full error.

The task stays `in_progress`. The message stops a `tau_wait` of the parent.
The parent decides: it sends a message to continue (a message starts a new
turn of the idle sub-agent), or it aborts the sub-agent. You can also type
in the pane of the sub-agent.

The sub-agent also records the kind of error in the task list, until its
next turn starts, or until a new pi session of the sub-agent starts (a
`/reload` keeps the record). The record has only one of the
fixed kinds of error: `tau` shows any other text as `other error`. While
the record is there:

- The tree shows `⚠ error` after the owner, and `tau_list` shows
  `@tau-t2-1 (stopped after an error)`.
- `tau_wait` returns at once when the owner of a task in its list stopped
  after an error (as for a failed task).
- The continuation message of the parent names the task, and it does not
  tell the parent to wait for it:

  ```text
    Stopped after an error: T2.1 (@tau-t2-1, timeout). Send a message to continue (tau_send), or stop it (tau_abort).
  ```

Limits:

- When the report cannot be sent (for example, the parent has 100
  messages that it did not read, or the task list cannot be changed),
  `tau` shows a warning in the pane of the sub-agent, and does not try
  again. Then the parent gets no message, but the record of the error (see
  below) still shows in its tree, its `tau_wait`, and its continuation
  messages, when `tau` could write the record.
- pi does not tell `tau` when you press `Esc` while `tau` sends the report.
  Then the report goes to the parent, and messages can start turns of the
  sub-agent.
- Each run that ends with an error sends one report. When the parent sends
  "continue" and the error comes again, each new run costs tokens of the
  parent too: the parent decides when it stops the sub-agent.

### Wait without polling

Sometimes no task is ready: each open task waits for a different agent. Then
the agent calls `tau_wait` with a list of tasks. The tool call blocks, and the
agent uses no tokens, until each task in the list is closed, until a
[message](#messages-and-notes) arrives for the agent, or until the owner of a
task stops after an error.

```text
● tau_wait T2.1, T4
  All 2 tasks are closed (after 252 s).
  T2.1  completed  Create login_tokens table
  T4  failed (retryable)  Security review of token storage
  Use tau_get to read the results.
```

When one task in the list fails, `tau_wait` returns at once, so that the agent
can retry the task or abort the other tasks. It also returns at once when
the owner of a task stopped after an error (see
[Errors of a sub-agent](#errors-of-a-sub-agent)). The result shows the tasks that
are still open:

```text
● tau_wait T2.1, T3, T4
  T4 failed (after 31 s). Other tasks can still be open.
  T2.1  in_progress (@tau-t2-1)  Create login_tokens table
  T3  in_progress (@tau-t3)  Update login page
  T4  failed (retryable)  Security review of token storage
  Use tau_get to read the results.
```

With `timeout_seconds`, `tau_wait` also returns when the time ends. Then
some tasks can still be open.

### Questions to the user

The agent does not end its turn to ask a question. It calls an "ask question"
tool from a different extension (for example
`npm:@juicesharp/rpiv-ask-user-question`). The agent waits inside that tool
call, so it does not stop. (Only the last-resort tool `tau_ask_user` ends
the turn: see below.) In a sub-agent, the question shows in the sub-agent
pane, and herdr shows that pane as `blocked`.

`tau` adds a `<tau>` section to the system prompt. It tells the rule, and
this instruction (without an `askTool`):

> To get an answer from the user, call an available "ask question" tool. Do
> not end your turn to ask a question.

#### Set the ask tool: `askTool`

Set `askTool` in the [configuration](#configuration) to the name of the "ask
question" tool that the agents must use (for example `ask_user_question`).
Then:

1. `tau` does not register `tau_ask_user`: the models do not see it.
2. The work gate never blocks this tool, also when the agent has no active
   task.
3. The `<tau>` section and the continuation messages tell the agent to call
   this tool:

   > To get an answer from the user, call the ask_user_question tool. Do not
   > end your turn to ask a question.

If the tool is not an active tool when a run starts (for example, its
extension is not installed), `tau` shows a warning. It shows it one time
after each start or `/reload` of `tau`. Then the agent cannot use this tool,
and `tau_ask_user` is not available.

> [!WARNING]
> Set `askTool` only to a tool that asks you a question and does nothing
> else. The work gate never blocks this tool: also when the agent has no
> active task, and also for a read-only task. A tool that runs commands or
> changes files (for example an MCP tool that calls other tools) then works
> outside the gate. `tau` cannot know what a tool does from its name. If a
> different extension registers a tool with this name, the gate allows that
> tool too.

#### If no "ask question" tool is set: `tau_ask_user`

When `askTool` is not set, `tau` registers `tau_ask_user` as the last
resort. If no "ask question" tool is available, the agent can call `tau_ask_user`
with a plain-text question. The tool shows the question and ends the turn. The
"do not stop" rule does not apply for this stop. Your next prompt is the
answer, and the agent continues the work from there.

The tool description tells the agent to use this tool only when no other "ask
question" tool is available, and to call it alone. If the agent calls more
tools in the same batch, pi does not end the turn at once. Then the rule
applies to the next stop. `tau` skips the rule only when the last turn had one
tool call: a `tau_ask_user` call that did not fail. A new user message (also a message
that you send while the agent works) starts the rule again. A message that a
different extension sends does not.

```text
● tau_ask_user
  The user sees this question:
  | Do you want magic links to expire after 15 minutes or after 1 hour?
  End your turn now. Do not call more tools. The next user prompt is the answer.
⏸ tau: waiting for your answer. Type it as your next prompt.
╭──────────────────────────────────────────────────────────────╮
│ > 15 minutes                                                 │
╰──────────────────────────────────────────────────────────────╯
```

---

## Messages and notes

Agents can send messages to other agents, and add notes to tasks.

- **Messages** go to one agent. Use them to steer a sub-agent, or to tell a
  different agent about an important result now.
- **Notes** stay on a task. Use them for findings that other agents can need
  later.

### Who can send a message to whom

Messages follow the agent tree. An agent can send a message to:

| Recipient                          | Typical use                          |
|------------------------------------|--------------------------------------|
| A sub-agent that it started, or a sub-agent of that sub-agent (any depth) | Steer the work. |
| The agent that started it (its parent) | Report a finding or a problem.  |
| A sibling: an agent with the same parent | Tell about a shared change.    |

`tau_send` fails for all other recipients. For a recipient outside this part
of the agent tree, the error tells the agent to send the message to its
parent, which can forward it. (`tau_send` also fails for the agent itself,
for an agent that does not exist, and for an agent that ended.)

### Priority

Each message has a priority:

| Priority | The recipient model gets the message                                          |
|----------|-------------------------------------------------------------------------------|
| `steer`  | With the result of its current (or next) tool call. Use it to change the work now. |
| `info`   | With the result of its next `tau_*` tool call, or at the end of its run.      |

With both priorities, a message stops a `tau_wait` call of the recipient. The
message comes with the result of the `tau_wait` call.

When the recipient is idle, the message starts a turn. `tau` starts at most
one such turn every 5 seconds: messages that arrive in that time come
together. `tau` does not start a turn:

- After a run that did not end normally (for example, you pressed `Esc`,
  or an error stopped the run), until your next prompt. One exception: after
  an error, messages start turns of a sub-agent, so that its parent can tell
  it to continue (see [Errors of a sub-agent](#errors-of-a-sub-agent)).
- While the agent waits for your answer to a `tau_ask_user` question.

A question to you (`tau_ask_user`) goes first: messages that arrive then
wait for your answer.

Limits of messages:

- An agent can have at most 100 messages that it did not read. Then
  `tau_send` fails, and tells the sender to wait.
- One delivery gives at most 40000 characters of messages (as the model
  gets them, with the quote marks). The rest comes with the next delivery.
- A single message must fit in one delivery. Else `tau_send` fails.
- Messages continue a run at most 5 times between two of your prompts.
  Then the next messages start a new turn (at most one every 5 seconds).

### How it looks

The sender:

```text
● tau_send
  to: @tau-t2-1
  priority: steer
  The tokens table must use the column name `expires_at`, not `expiry`.
  T2.3 depends on that name.
✔ Sent to @tau-t2-1 (T2.1), priority steer.
```

The recipient, in its pane, in the result of its current tool call:

```text
New messages:

✉ steer from @lead (T2). This message is from a different agent, not from the user:
| The tokens table must use the column name `expires_at`, not `expiry`.
| T2.3 depends on that name.
```

At the end of a run, or when the recipient is idle, the message comes as a
separate message:

```text
[tau-message]
✉ steer from @lead (T2). This message is from a different agent, not from the user:
| The tokens table must use the column name `expires_at`, not `expiry`.
| T2.3 depends on that name.
```

The text of a message is text that an agent wrote. So the recipient gets it
as quoted data, with a header that tells who sent it.

`tau` marks a message as read when it adds the message to the conversation
of the recipient (a tool result, or a message in the session). Then the `✉`
count in the tree goes down.

Limits:

- A tool call that pi does not run (for example, the work gate blocked it)
  does not give messages. The next tool result, or the end of the run,
  gives them.
- A different extension can change a tool result after `tau` added
  messages to it. Then the model does not get these messages.
- When `tau` starts a turn for an idle agent and pi cannot start it, the
  messages are marked as read, but the model did not get them.
- When you press `Esc` exactly while the agent stops (and it does not
  continue), pi does not tell `tau`. Then messages that arrive later can
  start a turn before your next prompt.

### Notes

Any agent can add a note to a task that it can see, with `tau_note`. A note has
an author, a time, and a Markdown text. Notes do not change the task status,
and the owner of the task does not have to be the author.

```text
● tau_note
  task: T1
  The session cookie is set in src/auth/session.ts:88, not in the middleware.
✔ Added note 3 to T1.
```

`tau_get` shows the notes of a task. `tau_list` shows the number of notes. Notes
are part of the task `history`, so a [fork](#fork) keeps only the notes from
before the fork point.

---

## Tools

All tools exist only when herdr is available.

| Tool            | Does                                                          |
|-----------------|---------------------------------------------------------------|
| `tau_list`      | Show a compact task list. See below.                          |
| `tau_get`       | Show one task with all fields.                                |
| `tau_create`    | Create a task or sub-task.                                    |
| `tau_update`    | Change `title`, `type`, `description`, or `dependencies`.     |
| `tau_claim`     | Claim a task for the current agent.                           |
| `tau_complete`  | Close the active task as `completed`, with a result.          |
| `tau_fail`      | Close the active task as `failed`, with a result and `retryable`. |
| `tau_cancel`    | Cancel a `waiting` task, with a reason.                       |
| `tau_delegate`  | Start a sub-agent for a task, with a model and thinking.      |
| `tau_abort`     | Stop a sub-agent and its sub-agents, and fail their tasks, with a reason. (A task with open sub-tasks fails when they close.) |
| `tau_wait`      | Wait until each task in a list is closed (`ids`, optional `timeout_seconds`). It returns at once when a task fails, when the owner of a task stopped after an error, or when a message arrives. |
| `tau_send`      | Send a message to an agent, with a priority.                  |
| `tau_note`      | Add a note to a task.                                         |
| `tau_ask_user`  | Ask the user a question, then end the turn. Only when no other "ask question" tool is available. It does not exist when `askTool` is set. |

### `tau_list`

By default, `tau_list` shows only tasks that are not `completed` or
`canceled`. Use `all: true` to see all tasks. The tasks show in the order
that they were made. Each line has only the `id`, status, title, owner, open
dependencies, `retryable` or `not retryable` for a failed task,
`(stopped after an error)` for an owner that stopped after an error, and the
number of notes. The last
lines tell your active task and the tasks that you can claim. Use `tau_get`
for the full task.

```text
● tau_list
  T2    in_progress  Add magic-link login endpoint                     @lead
  T3    waiting      Update login page                                 deps: T2
  T4    failed       Security review of token storage                  retryable  1 note
  T2.1  in_progress  Create login_tokens table                         @tau-t2-1
  T2.2  waiting      Write endpoint tests                              deps: T2.1
  (3 completed or canceled tasks hidden. Use all: true.)
  Your active task: T2.
```

"Ready to claim" lists only the tasks that you can claim now. When you have
an active task, these are its sub-tasks.

### `tau_create`

```text
● tau_create
  title: Create login_tokens table
  type: code
  parent: T2
  dependencies: [T1]
✔ Created T2.1 (waiting, ready to claim): Create login_tokens table
```

### `tau_get`

`tau_get` shows at most 2000 characters of the description and of the
result, and the last 10 notes and events. To read all of a field, set
`section` (`description`, `result`, `notes`, or `history`). The complete
field comes in pages of 8000 characters: each page tells the `offset` of the
next page.

Text that agents wrote shows with `| ` at the start of each line, under a
header that tells that it is data, not instructions. So this text cannot look
like a field of the result.

One exception: an agent follows a task description as instructions only
when `tau_get` shows it as the work of its task. This is the case for the
description of your own `in_progress` task, when one of these wrote it last:

- you,
- an agent above you in the agent tree (your parent, the parent of your
  parent, …, the lead),
- `tau` (the first task `T0`).

Without this exception, a sub-agent can think that its own task is a
prompt injection. The description stays data when a different agent wrote
it last: for example, when the lead claims a task that a sub-agent created,
or when an earlier owner changed the description before it failed the task.
Results and notes stay data for all agents.

### `tau_complete` and `tau_fail`

The `id` is optional. The default is your active task. `tau_fail` needs
`retryable`: `true` when a different attempt can succeed.

### Agent identity

The tools get the agent name and its scope from the pi process, never from
the tool arguments. A model cannot act as a different agent through the tau
tools. (See [The identity of a sub-agent](#the-identity-of-a-sub-agent) for
the limits of this.)

### Text from agents

Titles, descriptions, results, and notes are text that agents wrote. `tau`
removes terminal control characters and escape sequences from this text
before it shows it, so that the text cannot change the terminal. A title
cannot contain control characters.

---

## Commands and keys

| Input             | Does                                                 |
|-------------------|------------------------------------------------------|
| `ctrl+shift+t`    | Show or hide `completed` and `canceled` tasks. This is the default key: see `toggleCompletedKey` in the [configuration](#configuration). |
| `/tau`            | Show the full task list in a dialog.                 |
| `/tau show <id>`  | Show one task with all fields, complete.             |

`/tau` shows all tasks, with no line limit. `/tau show <id>` shows the
complete text of each field, all notes, and one line for each history event
(its time, agent, and kind). Long lines wrap. (Without the TUI, for example
in print mode, the commands show the text as a notification.) When the text is taller than the screen, use `Up`, `Down`,
`Page Up`, `Page Down`, `Home`, and `End` to move it. Press `Esc`, `Enter`,
or `q` to close the dialog.

---

## Storage

`tau` saves each task list on disk. The task list stays after a restart, a
compaction, or a session resume.

```text
~/.pi/tau/
├── config.json
└── tasklists/
    └── <lead-session-id>.db
```

The database has the task list and the messages between its agents. See
[Messages and notes](#messages-and-notes) for when an agent gets its
messages. The database keeps up to 2000 older messages that were read, and
the messages that were read in the last minute: `tau` removes the oldest
ones. Each agent
can have at most 100 messages that it did not read. At each send, `tau`
removes the unread messages of agents that ended.

`tau` does not hard-code this path. It uses the parent of the pi agent
directory, with `tau` added:

| pi agent directory (`PI_CODING_AGENT_DIR`) | tau directory       |
|--------------------------------------------|---------------------|
| `~/.pi/agent` (default)                    | `~/.pi/tau`         |
| `/opt/pi/agent`                            | `/opt/pi/tau`       |

`tau` reads the pi agent directory from `PI_CODING_AGENT_DIR`, or uses the
default. A program that starts pi with the SDK option `agentDir` and does not
set `PI_CODING_AGENT_DIR` gets the default tau directory.

Each task list is an SQLite database file. `tau` uses the `node:sqlite`
module of Node.js, so it needs no dependency. Each change is one SQLite
transaction.

- Sub-agents use the task list file of their lead. `tau` gives the path to the
  sub-agent in the `TAU_TASKLIST` environment variable, and the task `id` in
  `TAU_TASK_ID`.
- More than one agent can change the task list. SQLite lets only one process
  at a time change it. The lock is an operating system lock, so it ends
  automatically when its process stops. While a different process has the
  lock, `tau` waits for at most 5 seconds, and it does not block pi while it
  waits.

After you change or upgrade the files of `tau`, restart the lead (and its
sub-agents) before you continue the work. A sub-agent loads the `tau` files
of its lead when it starts, but a running lead keeps its old code, and an
older version removes the fields of the task list that it does not know
(for example, the error record of a sub-agent).

### Removal of old task lists

When a lead starts, `tau` removes the task lists of sessions that you cannot
resume any more: the session transcript (the pi session file) does not
exist. This runs in the background, and it does not stop the start.

The lead records the path of its session file in its task list. A session
with no file (`--no-session`) records that it has no file. `tau` removes a
task list only when all these conditions are true:

1. It is not the task list of the current session.
2. Its files (the database, and the `-wal` and `-shm` files) did not change
   for 1 day. pi makes the session file only after the first answer of the
   model, so a new session has no file yet.
3. `tau` can read the task list, and the list is for the session of its
   file name.
4. The session has no file, or `tau` finds no file of the session: the
   recorded file does not exist, and the search below finds no other file.
   (A session can have a different copy of its file, for example when you
   resumed it from an imported copy.)

The search: `tau` looks for `<time>_<session-id>.jsonl` in the default
session directory (`<pi agent directory>/sessions`), in
`PI_CODING_AGENT_SESSION_DIR`, in the session directory of the current
session, and in their direct sub-directories (also through symbolic links).
When a directory or a symbolic link cannot be read, `tau` keeps the list.

A task list from an older version of `tau` has no recorded path: `tau` uses
only the search. When the lead of such a list starts again, it records its
path.

Limits:

- `tau` searches only the directories above. A task list that is older
  than 1 day is removed when the only file of its session is in a different
  custom session directory (`--session-dir`, or the `sessionDir` setting of
  a different project), in these cases:
  - The list is from an older version of `tau` (it has no recorded path).
  - The recorded file does not exist any more (for example, an imported
    copy that you removed), but the original file is still there.
- A lead that runs, and did not change its task list for 1 day, can lose
  its task list when a different lead starts, if its session file does not
  exist (for example, a `--no-session` lead).
- `tau` does not lock a task list while it checks and removes it.

`tau` does not remove a file that is a symbolic link, or a file that it
cannot read.

The `tasklists` directory is for the current user only: `tau` makes it with
mode `0700`, and removes access for other users if it has it. New database
files (with the SQLite `-wal` and `-shm` files) have mode `0600`: `tau`
removes access for other users from an existing file too. `tau` does not
use a task list file or directory that is a symbolic link.

Limits of a task list:

- At most 16 MiB of task list data (the messages are not in this limit).
- At most 500 tasks, 100 notes for each task, and 1000 changes for each
  task. The change limit does not apply to a close (complete, fail, or
  cancel), but the 16 MiB limit does.
- At most 1000 agent records, also the records of agents that ended. Then
  `tau_delegate` fails.

`tau` checks these limits when it changes a task, and when it reads a task
list.

When a task list is not valid (the file is not a database, the data is not
JSON, or the fields of a task do not agree with its `history`), `tau` shows
an error and does not change the file.

### Fork

When you fork a session (`/fork`, `/clone`, or `pi --fork <session>`), the
new session gets a copy of the task list. `tau` uses the `history` of each
task to put the copied tasks back in their state at the fork point. Changes after the fork point are not in the
copy. The task list of the original session does not change.

Each change has a revision number, which is unique in the task list. The fork
point is a revision, not a time, so two changes in the same millisecond are
not a problem.

At the fork point, a sub-agent can own an `in_progress` task. That sub-agent
works for the original session, not for the fork. In the copy, these tasks
become `failed`, with the result `owner is in a different session` and
`retryable: true`, and the records of all sub-agents end. First, `tau`
cancels the `waiting` sub-tasks of these tasks (they are the plan of the old
sub-agent; a retry makes its own plan). A task of the lead stays
`in_progress`: the lead works in the fork too. If the lead owns a task under
a sub-agent task, the sub-agent task (and a `waiting` sub-task between them)
stays open: close or cancel them, then `tau` fails the sub-agent task
(rule 11). Messages between agents are not copied.

The sub-agents of the original session continue their work after the fork.
Nobody watches them while the original session is not open: the panes of
these sub-agents stay open when they finish. When you open the original
session again, its liveness check ends these sub-agents. It closes the pane
of each one when this is safe (see [Liveness](#liveness)): herdr must show
the sub-agent in the pane. If herdr does not show it, the pane stays open,
and you close it yourself.

How `tau` finds the fork point: before each message enters the session of
the lead (your prompts, the answers of the model, and the tool results),
`tau` writes the revision of the task list into the session when it
changed (a custom entry that the model does not get). So the entries also
have the changes of sub-agents while the lead was idle. pi copies these
entries up to the fork point into the new session. The last one is the fork
point.

The fork gets a new task list, and `tau` shows a warning, when:

- The session has no revision entry before the fork point (for example, a
  session from before this version of `tau`).
- The revision is not in the old task list, or the old task list is not the
  list of the old session.
- The copy is too large for a task list (the failed tasks add changes).
- `tau` cannot read the old task list.

An exception: with `pi --fork <session>`, a session with no revision entry
gets a new task list with no warning. pi gives the same start event for
`pi --fork` and for a session that `/new` made (both have a parent
session), so `tau` copies the list only when the session has a revision
entry.

The revision entries and the header of the old session file are not a
security boundary: a program of your user that changes them can change what
`tau` copies.

When the old session has no task list, the fork gets a new task list with
no warning. `tau` can copy the list only for a saved session: pi gives the
file of the old session only then.

A limit: `tau` records the revision before each message and before each
compaction. A custom message that a different extension adds while the lead
is idle does not trigger a record. A clone at such a message can miss the
changes of sub-agents after the last record.

---

## Configuration

Edit `~/.pi/tau/config.json` (in the [tau directory](#storage)). All fields
are optional. There is no configuration for each project. The file is JSON,
and it can have `//` and `/* */` comments. It can be a symbolic link. The
file is trusted input: it sets the work gate and the text that models get
(task type descriptions). Do not link it to a file that other users can
change.

The lead reads the file when the session starts, and again after
`/reload`. Sub-agents do not read the file: they get the configuration of
the lead (in `TAU_CONFIG`), so that all agents of one task list use the same
rules, also when the file changes (until `/reload`, see below). A sub-agent
that does not get a valid configuration from its lead does not work (see
[The identity of a sub-agent](#the-identity-of-a-sub-agent)).

After `/reload`, the new configuration of the lead applies to the lead and
to the sub-agents that start after it. Sub-agents that run already keep the
configuration that they got. To use one
configuration for all agents,
change the file before you start the work.

`tau` gives the configuration to a sub-agent in the arguments of a `herdr`
command. Other users of the computer can see process arguments. So do not
put secrets in the configuration (for example, in task type descriptions).
Also do not put secrets in task titles: each sub-agent gives the title of
its task to herdr (`herdr pane report-metadata --title`), and herdr shows it. When a field is not valid, `tau` uses the
default value of that field, and shows a warning with the reason. When the
file is not valid JSON, `tau` uses the default configuration.

| Field                  | Valid values                                              |
|------------------------|-----------------------------------------------------------|
| `toggleCompletedKey`   | A key: modifiers (`ctrl`, `shift`, `alt`, `super`), then a letter, a digit, a symbol, or a special key (`tab`, `pageUp`, …). See the rules below the table. |
| `idPills`              | `true` or `false`.                                        |
| `maxTreeLines`         | An integer from 1 to 100.                                 |
| `maxParallelSubAgents` | An integer from 1 to 32.                                  |
| `maxIdleContinuations` | An integer from 0 to 100. With 0, the "do not stop" rule gives up at the first early stop. |
| `askTool`              | The name of the "ask question" tool of a different extension: a letter, then `a-z`, `A-Z`, `0-9`, `_`, and `-` (at most 64 characters). Not a `tau_*` tool, and not a built-in tool (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Not set by default. See [Set the ask tool](#set-the-ask-tool-asktool). |
| `taskTypes`            | 1 to 50 types. A name starts with `a-z`, then has `a-z`, `0-9`, and `-` (at most 32 characters). Each type has a `description` (1 to 300 characters) and an optional `readOnly`. The list must have `plan`, the type of the first task `T0`. If one type is not valid, `tau` uses the default list. |

Rules for `toggleCompletedKey`:

- It must have `ctrl`, `alt`, or `super`, so that it does not catch normal
  input. A function key (`f1` … `f12`) has no modifier.
- Not Escape, and not `+`.
- Not `[`, `]`, or `\`: with `ctrl`, the terminal sends the same bytes as
  Escape.
- Not `ctrl` with `h`, `i`, `j`, or `m`: the terminal sends the same bytes as
  Backspace, Tab, and Enter.

The file can have at most 64 KiB. A larger file gives a warning, and `tau`
uses the default configuration.

```jsonc
{
  // Key that shows or hides completed and canceled tasks.
  "toggleCompletedKey": "ctrl+shift+t",

  // Show task IDs as colored powerline pills. Needs a Nerd Font.
  "idPills": true,

  // Maximum number of task lines in the tree widget.
  "maxTreeLines": 6,

  // Maximum number of sub-agents that run at the same time.
  "maxParallelSubAgents": 4,

  // Number of continuations with no task change before tau stops the
  // "do not stop" rule and notifies you.
  "maxIdleContinuations": 3,

  // The "ask question" tool of a different extension. When it is set, tau
  // does not register tau_ask_user. Not set by default. Read the warning in
  // "Set the ask tool" before you set it.
  // "askTool": "ask_user_question",

  // Task types. This list replaces the default list.
  "taskTypes": {
    "plan":     { "description": "Make or change the task list." },
    "research": { "description": "Read code, docs, or the web. No file changes.", "readOnly": true },
    "code":     { "description": "Change code or files." },
    "test":     { "description": "Write or run tests." },
    "review":   { "description": "Read-only check of work done by other tasks.", "readOnly": true },
    "docs":     { "description": "Write documentation." }
  }
}
```
