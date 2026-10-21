# pi-task-tracker

As an SRE I juggle multiple projects at once. They differ in tech stack, in
the engineers I talk to, and in planning cycles. Every switch forces a
context reload: where was I, what changed, what is blocked, what comes next.
This constant re-remembering splits my attention and slows me down.

This extension binds each Pi session to a task and records goal-relevant
progress automatically. When I return to a project, the task state is
already there: status, summary, next action, and blockers. You resume instead
of reconstructing.

All data stays on my machine in a local SQLite database. No service, no
account.

## Quick Start

Install for your Pi account:

```sh
pi install npm:@showjason/pi-task-tracker@beta
```

Confirm that Pi sees it:

```sh
pi list
```

Start Pi in the project where you work, finish one normal turn, then ask Pi
to create and bind a task:

```text
Create a task named "deploy-api-v2". Its goal is to deploy the new API to
production. Bind this session to it.
```

Continue working normally. The extension records progress only when it finds
goal-relevant changes. Run `/tasks` at any time to inspect your tasks.

### Install for one project

Run this from the project directory:

```sh
pi install --local npm:@showjason/pi-task-tracker@beta
```

Pi asks you to trust the project before it loads project-local extensions.

### Install from git

```sh
pi install git:github.com/showjason/pi-task-tracker
```

### Install from a checkout

Use this when developing the extension:

```sh
git clone git@github.com:showjason/pi-task-tracker.git
cd pi-task-tracker
npm ci
pi install "$PWD"
```

Local packages keep using the checkout. Run `pi reload` after changing
extension files.

## Requirements

- Pi with package installation support. This extension is tested with
  `@earendil-works/pi-coding-agent` 0.85.1.
- Node.js 22.19 or later when Pi is installed through npm or used from source.
- A working Pi model provider. Run `/login` in Pi, or configure the provider
  before using the extension.
- The `pi` command must be on `PATH`. The extension starts a child Pi process
  to write summaries.

Install only sources you trust. Pi extensions run with the permissions of the
Pi process and can read project files, session content, and local
credentials.

## Features

### Task management with `/tasks`

Run `/tasks` to open the task list.

| Action                     | Keys                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| Select a task              | Up / Down arrows                                                       |
| View or close task details | Enter                                                                  |
| Scroll long details        | `j` / `k`                                                              |
| Filter by status           | `1` all, `2` in progress, `3` pending, `4` todo, `5` done, `6` blocked |
| Delete the selected task   | `d`, use Left / Right to select **Delete**, then Enter                 |
| Close the task list        | Escape or Ctrl-C                                                       |

The task bound to the current session cannot be deleted. Deletion is
permanent.

The extension registers these model tools:

| Tool                    | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `tracker_create_task`   | Create a local task.                                                |
| `tracker_bind_task`     | Bind the current Pi session to an existing task.                    |
| `tracker_apply_summary` | Internal tool used by the summary process. Do not call it directly. |

### Automatic progress tracking

The extension tracks completed assistant turns. A summary is written when one
of these events occurs:

- the configured completed-turn threshold is reached;
- the session remains idle until the configured timer fires;
- Pi changes tree branch, forks, switches sessions, or exits.

The summary process compares the new session entries with the task goal and
current task state. It can update status, priority, progress, summary, next
action, and blocker. It does not update a task for unrelated conversation.

### Isolated summary process

For each summary job, the extension starts a separate, non-interactive `pi`
process. The child runs only `tracker_apply_summary`; it cannot use
extensions or Pi built-in tools.

The child inherits the Pi process environment. It reuses Pi's configured
provider definitions, model definitions, and login credentials. The
`SUMMARIZER_PROVIDER` and `SUMMARIZER_MODEL` settings select the provider and
model from that Pi configuration. They do not automatically follow a later
model selection in the parent session.

## Configuration

Set environment variables before starting Pi. The defaults are suitable for
normal interactive use. The default tracker home is `~/.pi/agent/tracker`.
When Pi sets `PI_CODING_AGENT_DIR`, the extension uses
`$PI_CODING_AGENT_DIR/tracker` instead.

| Variable               |                        Default | Meaning                                                              |
| ---------------------- | -----------------------------: | -------------------------------------------------------------------- |
| `TRACKER_HOME`         | `$PI_CODING_AGENT_DIR/tracker` | Directory for the database and logs.                                 |
| `TURNS_THRESHOLD`      |                            `3` | Completed turns before a summary check.                              |
| `INITIAL_INTERVAL_MIN` |                           `30` | First idle check interval.                                           |
| `MAX_INTERVAL_MIN`     |                          `120` | Maximum idle interval after no useful increment.                     |
| `SUMMARIZER_PROVIDER`  |                       `openai` | Pi provider for the summary child process.                           |
| `SUMMARIZER_MODEL`     |            `DeepSeek-V4-Flash` | Pi model for summaries.                                              |
| `USE_GATE`             |                        `false` | Use JEV to decide whether a turn or timer increment needs a summary. |
| `SUMMARY_TIMEOUT_MS`   |                        `60000` | Maximum shutdown wait for a summary process.                         |
| `LOG_LEVEL`            |                         `info` | `error`, `warn`, `info`, or `debug`.                                 |
| `LOG_DIR`              |           `$TRACKER_HOME/logs` | Log directory.                                                       |

For a short manual test:

```sh
export TRACKER_HOME="$HOME/.tracker-test"
export TURNS_THRESHOLD=1
export INITIAL_INTERVAL_MIN=1
export MAX_INTERVAL_MIN=2
pi
```

Delete the test directory after the test if it is no longer needed:

```sh
rm -rf "$HOME/.tracker-test"
```

## Data and Logs

By default, the extension creates:

```text
~/.pi/agent/tracker/
  tracker.db
  logs/
    tracker/
    summary/
```

Inspect the current tasks with SQLite:

```sh
sqlite3 ~/.pi/agent/tracker/tracker.db \
  "SELECT title, status, priority, revision, substr(summary, 1, 80) FROM tasks;"
```

Follow summary failures while testing:

```sh
tail -f ~/.pi/agent/tracker/logs/summary/*.log
```

## Troubleshooting

| Symptom                            | Check                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pi list` does not show tracker    | Re-run the install command and check that the source is reachable.                                                       |
| Pi reports an extension load error | Run `node --version`, then check `npm run check` from a checkout. Invalid environment-variable values also stop startup. |
| No task appears in `/tasks`        | Ask Pi to create the task first. The command does not create tasks itself.                                               |
| Binding fails for a new session    | Finish one normal assistant response, then bind again.                                                                   |
| Summaries do not update tasks      | Check that Pi has a logged-in provider, that `pi` is on `PATH`, and inspect `$TRACKER_HOME/logs/summary/`.               |

## Update and Remove

For an npm package install:

```sh
pi update --extensions
pi remove npm:@showjason/pi-task-tracker
```

For a local checkout, remove the same path that you installed:

```sh
pi remove "$PWD"
```

Removing the package does not delete `TRACKER_HOME`. Remove that directory
separately only when you also want to delete local task data and logs.

## Development

```sh
npm ci
npm run check
npm test
```

The test suite uses temporary SQLite databases and fakes the summary process.
It does not require a model provider.

## License

[MIT](LICENSE)
