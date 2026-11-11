# pi-task-tracker

`pi-task-tracker` helps you keep track of work that spans several Pi sessions.
Bind a session to a task, then continue working normally. The extension records
goal-relevant progress and gives you the current status, summary, next action,
and blocker when you return.

All task data stays in a local SQLite database. It does not require an account
or a remote service.

## When to use it

Use this extension when you:

- work on several projects or long-running tasks at the same time;
- switch branches, sessions, or repositories and need to recover context;
- want Pi to maintain concise task progress without manual status updates.

Each task can have more than one session, but use only one Pi process to
advance a task at a time.

## Quick start

### 1. Install

Install the extension for your Pi account:

```sh
pi install npm:@showjason/pi-task-tracker
```

Or install it only for the current project:

```sh
pi install --local npm:@showjason/pi-task-tracker
```

Run `pi list` to confirm that Pi can load the extension.

### 2. Create and bind a task

Start Pi in your project and use a prompt like this:

```text
Create a task named "deploy-api-v2". Its goal is to deploy the new API to
production. Bind this session to it.
```

After Pi binds the task, work as usual. The extension updates the task only
when it finds progress that is relevant to the task goal.

### 3. Check your tasks

Run `/tasks` to open the task list. Use the arrow keys to select a task and
Enter to view its details. Press Escape or Ctrl-C to close the list.

## How it works

The extension checks for progress after a configured number of completed turns,
after an idle period, and when Pi changes branches, forks, switches sessions,
or exits. It records only changes that relate to the bound task.

Use `/tasks` to review task state. It supports these shortcuts:

| Action | Keys |
| --- | --- |
| Select a task | Up / Down |
| Open or close details | Enter |
| Scroll details | `j` / `k` |
| Filter by status | `1` all, `2` in progress, `3` pending, `4` todo, `5` done, `6` blocked |
| Delete a task | `d`, then select **Delete** and press Enter |

You cannot delete the task bound to the current session. Deletion is permanent.

## Tools

Pi can call these tools while you work. In normal use, describe the task in
natural language and let Pi select the tool.

### `tracker_create_task`

Creates a tracked task. The task title must be unique.

| Parameter | Required | Description |
| --- | --- | --- |
| `title` | Yes | Unique task title |
| `goal` | No | Definition of done |
| `description` | No | Task context and scope |
| `jiraKeys` | No | Related Jira issue keys, as a string array |
| `priority` | No | `p0`, `p1`, `p2`, or `p3`; default: `p2` |
| `dueDate` | No | Due date in `YYYY-MM-DD` format |

### `tracker_bind_task`

Binds the current Pi session to an existing task.

| Parameter | Required | Description |
| --- | --- | --- |
| `title` | Yes | Title of the existing task |

### `tracker_apply_summary`

This is an internal tool for the isolated summary process. Do not call it
directly.

## Configuration

Set environment variables before you start Pi. The default settings work for
normal interactive use.

| Variable | Default | Description |
| --- | --- | --- |
| `TRACKER_HOME` | `$PI_CODING_AGENT_DIR/tracker` | Directory for the local database and logs |
| `TURNS_THRESHOLD` | `3` | Completed turns before a summary check |
| `INITIAL_INTERVAL_MIN` | `30` | First idle check interval, in minutes |
| `MAX_INTERVAL_MIN` | `120` | Maximum idle interval, in minutes |
| `SUMMARIZER_PROVIDER` | `openai` | Pi provider for summaries |
| `SUMMARIZER_MODEL` | `DeepSeek-V4-Flash` | Pi model for summaries |
| `USE_GATE` | `false` | Use JEV to decide if a summary is needed |
| `SUMMARY_TIMEOUT_MS` | `60000` | Maximum wait for a summary process, in milliseconds |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |
| `LOG_DIR` | `$TRACKER_HOME/logs` | Log directory |

By default, the database is at `~/.pi/agent/tracker/tracker.db`. When Pi sets
`PI_CODING_AGENT_DIR`, the extension uses `$PI_CODING_AGENT_DIR/tracker`
instead.

## Requirements

- Pi with extension package installation support. This project is tested with
  `@earendil-works/pi-coding-agent` 0.85.1.
- Node.js 22.23.4 or later when Pi is installed with npm or run from source.
- A configured Pi model provider. Use `/login` or configure a provider before
  you start Pi.
- The `pi` command must be on `PATH`.

Install extensions only from sources you trust. Extensions run with the same
permissions as Pi and can access project files, session content, and local
credentials.

## Development

```sh
npm ci
npm run check
npm test
```

## License

[MIT](LICENSE)
