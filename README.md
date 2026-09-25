# tau

> **Status: DRAFT.** This README describes the extension as if it is complete.
> We use it to set the requirements. Text in `> [!QUESTION]` blocks is not
> decided yet.

`tau` is an opinionated [pi](https://github.com/earendil-works/pi) extension
for one workflow: a lead agent plans work as a task list, then delegates each
task to sub-agents that run in [herdr](https://herdr.dev) panes. The agents do
not stop until all tasks are done.

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

When herdr is not available, `tau` does nothing else. It registers no tools, no
commands, and no keys. Its only hooks are the `session_start` handler, which
does the check and shows the badge, and the `session_shutdown` handler, which
removes the badge. Pi runs in its standard mode. The badge is the only
difference.

`tau` does the check one time, in the first `session_start` event. The result
stays the same until pi reloads the extension (`/reload`).

---

## The task list

Each pi session has one task list. When a session starts and has no task list,
`tau` creates one with a single task:

```text
T0  [plan]  Prepare task list
```

This task tells the agent to read the user prompt, plan the work, and create the
tasks it needs.

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

`tau` has these types by default. You can change them or add more in the
[configuration](#configuration).

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
sub-task for each deliverable:

```text
○ T0    Prepare task list
├─ ○ T0.1  Write plan in docs/plan.md
└─ ○ T0.2  Get user approval for the plan        ⧗ T0.1
```

### The task tree widget

The task list shows as a tree under the herdr badge. The root tasks stem from
the 🟢 badge.

By default, task IDs show as [colored pills](#colored-id-pills). The previews
in this section show the status marks instead (the `idPills: false` option),
because a text preview cannot show colors.

**Default view.** `completed` and `canceled` tasks are hidden. A closed task
shows only when one of its sub-tasks shows (for example, a `failed` sub-task
of a `completed` task). `⧗` shows only the dependencies that are not
complete.

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

**All tasks view** (after `ctrl+shift+t`). `⧗` shows all dependencies. A
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
| `✉n` | The owner has `n` messages that it did not read. |

Example with messages that are not read yet:

```text
🟢 Herdr ─ 1 waiting · 3 running
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
   tools except the `tau_*` tools. See [Work gate](#work-gate).
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
12. The lead decides if it retries a `failed` task.

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
its task (rule 11), and closes its pane. It does the same for the sub-agents of that sub-agent, at all depths,
because nobody watches them now. A sub-agent that is still starting has 2
minutes before `tau` checks it. When you move the pane of a sub-agent, `tau`
records its new pane.

A sub-agent ends when its task is closed, it has no live sub-agents, and it
is idle. If it is not idle 2 minutes after its task closed, it ends too. An
ended sub-agent cannot change tasks (it can still add notes).

`tau` closes the pane of an ended sub-agent only when herdr shows that
sub-agent in the pane (the same name and pi session), or when this pi made
the pane and no agent is in it. When the sub-agent moved, `tau` closes its
current pane. So an old record cannot close a different pane, for example
yours. (This is not a security boundary: a program of your user that writes
false records in the task list can make `tau` close a pane.) When a close fails, `tau` tries again at the next check.

The lead can also stop existing (for example, you close its pane). When you
resume the lead session, `tau` compares the task owners with
`herdr agent list`. Each `in_progress` task whose owner does not exist becomes
`failed`, with the result `owner agent exited` and `retryable: true`.

### Work gate

If an agent calls a tool that is not a `tau_*` tool, and it owns no
`in_progress` task, `tau` blocks the call:

```text
✖ bash
  tau blocked bash: you have no active task. All work must be for a task that you own.
  1. Find the task that this work is for (tau_list), and claim it (tau_claim).
  2. If no task is correct, create one (tau_create), then claim it.
  Do only the work that the active task needs.
```

If `tau` cannot read the task list, it blocks the call too, and tells why.
If `tau` cannot open the task list when the session starts, it shows an
error and registers no tools and no gate: pi runs in its standard mode.

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

1. The lead calls `tau_delegate` with a task that nobody owns, a model, and a
   thinking level.
2. `tau` gives the task to a new agent name, for example `tau-t2-1` for
   `T2.1`. The new agent is the task owner, and the status is `in_progress`.
   If the name is used (for example for a retry), `tau` adds a number:
   `tau-t2-1-2`.
3. `tau` splits the pane of the agent that delegates (to the right for a wide
   pane, down for a narrow pane), and starts pi in the new pane:
   `herdr agent start tau-t2-1 --kind pi --pane <new-pane> -- --model … --thinking … --extension <tau>`
4. The sub-agent receives a first prompt: its task ID and title, and what to
   do when the work is done.
5. The sub-agent can see the full task list. It can change only its task and
   the sub-tasks of its task.
6. The sub-agent can delegate its own sub-tasks to more sub-agents.
7. When the sub-agent closed its task and is idle, `tau` closes its pane. The
   task `result` keeps the output.

If a step after step 2 fails (for example, pi does not start), the task
becomes `failed` with `retryable: true`, and `tau` closes the new pane.

Sub-agents are always pi agents. The new pane is a sibling of the pane of the
agent that delegates, in the same tab. `tau` does not move the focus to the new
pane. The sub-agent loads the pi extensions of your pi settings, and tau.
Extensions that you gave to the lead with `-e` only are not loaded.

An agent can delegate a task while it works on a different task: delegation
is not work. When the parent task is `in_progress`, only its owner can
delegate its sub-tasks.

### The identity of a sub-agent

The new pane gets these environment variables:

| Variable           | Value                                               |
|--------------------|-----------------------------------------------------|
| `TAU_TASKLIST`     | The path of the task list database of the lead.     |
| `TAU_TASK_ID`      | The task of the sub-agent, for example `T2.1`.      |
| `TAU_AGENT_NAME`   | The herdr name of the sub-agent: `tau-t2-1`.        |
| `TAU_PARENT_AGENT` | The agent that started it: `lead` or `tau-…`.       |

`tau` does not trust these values alone. The database must be in the tau
directory, and the task list must have a record of this sub-agent, with the
same task, parent, and herdr pane. The task must be `in_progress`, with the
sub-agent as owner. If not, `tau` shows an error and registers nothing in
that pi.

These checks keep the agents of one user in order. They are not a security
boundary between agents: a program of the same user (for example a `bash`
command of a model) can change the environment and the database.

### What herdr shows

Each tau pi tells herdr what its pane is (`herdr pane report-metadata`):

| Pane      | Title                         | Agent label     | Tokens                                          |
|-----------|-------------------------------|-----------------|-------------------------------------------------|
| lead      | `tau lead`                    | `tau lead`      | `tau_role=lead`                                 |
| sub-agent | `tau-t2-1 · T2.1 <task title>` | `tau sub-agent` | `tau_role=subagent`, `tau_task=T2.1`, `tau_parent=lead` |

herdr knows each sub-agent by its name (`herdr agent list`), and the herdr
pi integration reports its state (`working`, `idle`, `blocked`). The badge of
a sub-agent tells its name and its task: `🟢 Herdr @tau-t2-1 (T2.1)`. When pi
stops, `tau` removes its metadata from the pane.

At most 4 sub-agents run at the same time, for the full task list. You can
change this limit in the [configuration](#configuration). When the limit is
reached, `tau_delegate` fails with a message that tells the agent to use
`tau_wait`.

```text
┌─ lead (w1:p1) ────────────────────┬─ tau-t2-1 (w1:p2) ───────────────┐
│ ● tau_delegate T2.1               │ ◐ T2.1 Create login_tokens table │
│   model: <from routing rules>     │                                  │
│   thinking: medium                │ ● read src/db/schema.ts          │
│ ✔ tau-t2-1 started in w1:p2       │ ● edit src/db/schema.ts          │
│                                   │                                  │
│ ● tau_wait T2.1, T4               │                                  │
│   waiting…                        │                                  │
├───────────────────────────────────┤                                  │
│ 🟢 Herdr ─ 2 waiting · 2 running  │ 🟢 Herdr ─ sub-agent of @lead    │
│ ├─ ◐ T2    Add magic-link…  @lead │ └─ ◐ T2.1  Create login_…        │
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

---

## The "do not stop" rule

An agent cannot stop while its task list has open work.

- **Lead:** it cannot stop while a task in the list is `waiting` or
  `in_progress`.
- **Sub-agent:** it cannot stop while its task is `in_progress`.

When the agent tries to stop too early, `tau` sends a continuation message:

```text
⟳ tau: 5 tasks are open (T1, T2, T3, T2.1, T2.2). Continue the work. Do not stop before the work is done.
  Your active task: T2. Do its work, then close it with tau_complete or tau_fail.
  Not ready: T1 (@tau-t1), T2.1 (@tau-t2-1), T3 (waits for T2), T2.2 (waits for T2.1).
  Use tau_wait with ids ["T1","T2.1"]. Do not poll.
  If you must have an answer from the user, call an ask question tool (or tau_ask_user if no other one is available). Do not end your turn to ask.
```

The message tells the agent to claim or delegate a ready task. The
message has only task IDs, statuses, and agent names. It does not have task
titles: the model gets the message as a user message, and text that agents
wrote must not look like an instruction of the user. If `tau` cannot read the
task list, the agent stops, and `tau` shows a warning.

After 3 continuations with no change to the task list, `tau` stops the rule and
notifies you. The rule is off until your next prompt. You can change this
limit in the [configuration](#configuration).

The rule does not apply when you stop the agent (for example with `Esc`), or
when the run ends with an error. A failed task is not open work: the lead
decides if it retries the task.

### Wait without polling

Sometimes no task is ready: each open task waits for a different agent. Then
the agent calls `tau_wait` with a list of tasks. The tool call blocks, and the
agent uses no tokens, until each task in the list is closed, or until a
[message](#messages-and-notes) arrives for the agent.

```text
● tau_wait T2.1, T4
  ✔ T2.1 completed (4m 12s)
  ✖ T4   failed: agent exited (retryable)
```

When one task in the list fails, `tau_wait` returns at once, so that the agent
can retry the task or abort the other tasks. The result shows the tasks that
are still open:

```text
● tau_wait T2.1, T3, T4
  ✖ T4   failed: agent exited (retryable)
  ◐ T2.1 still in_progress
  ◐ T3   still in_progress
```

### Questions to the user

The agent does not end its turn to ask a question. It calls an "ask question"
tool from a different extension (for example
`npm:@juicesharp/rpiv-ask-user-question`). The agent waits inside that tool
call, so it does not stop. In a sub-agent, the question shows in the sub-agent
pane, and herdr shows that pane as `blocked`.

`tau` adds a `<tau>` section to the system prompt. It tells the rule, and
this instruction:

> To get an answer from the user, call an available "ask question" tool. Do
> not end your turn to ask a question.

#### If no "ask question" tool is available: `tau_ask_user`

If no "ask question" tool is available, the agent can call `tau_ask_user`
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
  Do you want magic links to expire after 15 minutes or after 1 hour?
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

`tau_send` fails for all other recipients. The error tells the agent to send
the message to its parent, which can forward it.

### Priority

Each message has a priority:

| Priority | The recipient model gets the message                           |
|----------|----------------------------------------------------------------|
| `steer`  | After its current tool call. Use it to change the work now.    |
| `info`   | At its next `tau_*` tool call, or at the end of its turn.      |

With both priorities, a message stops a `tau_wait` call of the recipient. The
message is the result of the `tau_wait` call.

### How it looks

The sender:

```text
● tau_send
  to: @tau-t2-1
  priority: steer
  The tokens table must use the column name `expires_at`, not `expiry`.
  T2.3 depends on that name.
✔ Sent to @tau-t2-1 (T2.1)
```

The recipient, in its pane:

```text
✉ steer from @lead (T2)
  The tokens table must use the column name `expires_at`, not `expiry`.
  T2.3 depends on that name.
```

When the message reaches the model of the recipient, `tau` marks it as read,
and the `✉` count in the tree goes down.

### Notes

Any agent can add a note to a task that it can see, with `tau_note`. A note has
an author, a time, and a Markdown text. Notes do not change the task status,
and the owner of the task does not have to be the author.

```text
● tau_note
  task: T1
  The session cookie is set in src/auth/session.ts:88, not in the middleware.
✔ Added note 3 to T1
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
| `tau_abort`     | Stop a sub-agent and its sub-agents, and fail their tasks, with a reason. |
| `tau_wait`      | Wait until each task in a list is closed (`ids`, optional `timeout_seconds`). |
| `tau_send`      | Send a message to an agent, with a priority.                  |
| `tau_note`      | Add a note to a task.                                         |
| `tau_ask_user`  | Ask the user a question, then end the turn. Only when no other "ask question" tool is available. |

### `tau_list`

By default, `tau_list` shows only tasks that are not `completed` or
`canceled`. Use `all: true` to see all tasks. Each line has only the `id`,
status, title, owner, open dependencies, and the number of notes. The last
lines tell your active task and the tasks that you can claim. Use `tau_get`
for the full task.

```text
● tau_list
  T2    in_progress  Add magic-link login endpoint   @lead
  T2.1  in_progress  Create login_tokens table       @tau-t2-1
  T2.2  waiting      Write endpoint tests            deps: T2.1
  T3    waiting      Update login page               deps: T2
  T4    failed       Security review of token store  retryable  1 note
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
| `ctrl+shift+t`    | Show or hide `completed` and `canceled` tasks.       |
| `/tau`            | Show the full task list in a dialog.                 |
| `/tau show <id>`  | Show one task with all fields, complete.             |

`/tau` shows all tasks, with no line limit. `/tau show <id>` shows the
complete text of each field, with all notes and all history events. Long
lines wrap. When the text is taller than the screen, use `Up`, `Down`,
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
    ├── <lead-session-id>.db
    └── <lead-session-id>.messages/
        └── <agent-name>.jsonl
```

Each agent has one message file (its inbox). `tau` watches the inbox file of
the current agent, and adds new messages to the conversation.

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

The `tasklists` directory is for the current user only: `tau` makes it with
mode `0700`, and removes access for other users if it has it. The database
files (with the SQLite `-wal` and `-shm` files) have mode `0600`: `tau`
removes access for other users from an existing file too. `tau` does not use a task list file or directory that
is a symbolic link. A task list can have at most 16 MiB of data, 500 tasks,
100 notes for each task, and 1000 changes for each task. The change limit
does not apply to a close (complete, fail, or cancel), but the 16 MiB limit
does. `tau` checks these limits when it changes a task, and when
it reads a task list.

When a task list is not valid (the file is not a database, the data is not
JSON, or the fields of a task do not agree with its `history`), `tau` shows
an error and does not change the file.

### Fork

When you fork a session (`/fork`), the new session gets a copy of the task
list. `tau` uses the `history` of each task to roll the copy back to its state
at the fork point. Changes after the fork point are not in the copy.

Each change has a revision number, which is unique in the task list. The fork
point is a revision, not a time, so two changes in the same millisecond are
not a problem.

At the fork point, a sub-agent can own an `in_progress` task. That sub-agent
works for the original session, not for the fork. In the copy, these tasks
become `failed`, with the result `owner is in a different session` and
`retryable: true`.

---

## Configuration

Edit `~/.pi/tau/config.json`. All fields are optional. There is no
configuration for each project.

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
