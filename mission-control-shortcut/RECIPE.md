# Mission Control Shortcut

A native Shortcut board for the current repository or all configured spaces. Compact cards separate To do and In progress, open their source story, and start an installed coding tool with one click. Stories load through a headless Claude Code run that uses Claude Code's own Shortcut MCP sign-in, so no Shortcut token is stored.

![Mission Control Shortcut](preview.png)

## What you see

Follow Herdr's theme, like Mission Control Jira. Default docking is right, 380 px wide. A 38 px header shows the local Shortcut icon, one Shortcut title, the repository caption and an icon-only agent-shortcut control. Suppress this header when the surrounding layout already names the source.

Show This space / All spaces, a retained search field, refresh/settings icons, then All / To do / In progress filters with counts. There is no Done column. Cards show the `sc-<id>` key and the story title, both linked to the story. The footer reports loaded counts and the age of the last load, and says Refreshing while a load runs. A board that has never loaded says so and asks for Refresh.

## How it behaves

Each load is one small model run (about 1 cent and 30 seconds), so the board never loads on its own: not on open, focus or a timer. It shows the last loaded cards, kept in Herdr's shared state, with their age. Refresh runs one load per bound repository, one after another, and keeps the old cards while it runs. Set up loads once after it saves.

To do searches `<base> is:unstarted` and In progress searches `<base> is:started`, where `<base>` is the saved search, or `owner:<mention name>` when there is none. Set up checks the connection with Claude Code, shows the signed-in mention name and workspace, then saves the repository binding with an optional search.

Errors keep the cached cards and name the fix: Claude Code not found (enter its full path in Set up), the $0.10 run budget reached, Shortcut sign-in needed (run /mcp in Claude Code and sign in to shortcut), a failed run, or a run stopped after two minutes.

## Built from

Ship only `mods/mission-control-shortcut/` containing bundled native ESM `main.js`, `mod.json`, self-contained Node ESM `backend.mjs`, local SVG `assets/` and `NOTICE.md`; place this recipe and a real `preview.png` beside `mods/`. Default `props.view` is `panel`; support `setup`, `launch`, `settings` and `menu`, plus `hideHeader`, `scope: "space" | "all"` and immutable repository `target` props.

**Access disclosure:** reads/writes Mission Control configuration and launch/session/name journals outside the mod folder. Runs local Node.js 22+, Claude Code (`claude -p` with haiku, a $0.10 budget, only the Shortcut MCP server at https://mcp.shortcut.com/mcp and one read tool), Git/Python 3 and the selected agent on the execution host. Creates worktrees and sends the story task to that agent. Opens the story URL with the system browser. Stores no credentials; Claude Code keeps its own Shortcut sign-in.

## Watch out

Never load automatically. Validate every model result strictly and reject it rather than repair it. Counts that differ from Shortcut's totals are reported as incomplete. Shortcut reads run on this Mac even when the repository is remote.

## Done when

- `herdr-app check <copied-mod-folder>` passes with only this custom mod installed.
- Native clicks prove both columns, search, story links, Refresh and Set up.
