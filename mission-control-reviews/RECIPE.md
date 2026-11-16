# Mission Control Reviews

A native review queue: open pull requests that ask for your review, in every repository your `gh` account can see. Each card starts an installed coding tool on the review in a new worktree of that repository, with one click.

## What you see

Follow Herdr's theme, like Mission Control GitHub. Default docking is right, 380 px wide. A 38 px header shows the local review icon and one Reviews title. Suppress this header when the surrounding layout already names the source.

A status line shows how many reviews are asked of you and of your teams, the age of the last read, and Refreshing while one runs, then refresh and settings icons. An error goes on its own line under it, and the old cards stay. Two sections follow: **Asked of you** (direct requests) and **Asked of your teams**, each oldest first.

Cards show `owner/repo#n` and the title, both linked to the pull request, the author, the waiting time, a Draft badge, and the review decision and check rollup when GitHub returns them. A multi-line instructions box starts empty and is never saved. The board's pinned tools appear as buttons that read Review, with the tooltip "Review owner/repo#n with Claude".

## How it behaves

Two GitHub searches through the REST search API, 100 a page, at most three pages each, sorted by last update, oldest first: `is:pr is:open archived:false review-requested:@me` (you or one of your teams) and `is:pr is:open archived:false user-review-requested:@me` (you directly). Team requests are the first set minus the second. One GraphQL call per 100 pull requests reads the review decision and check rollup; if it fails, the cards leave them out and the status line says so. Search does not report when a review was requested, so the waiting time is since the pull request's last update, and the card's tooltip says so.

Reading is free, so the queue reads when it is first shown, then every 5 minutes while shown, and on Refresh. In the Mission Control layouts it is "shown" only while Reviews is the selected source (and, in Classic, the work panel is open).

Set up picks the `gh` account once: GitHub site, `gh` account and a profile ID, checked with `GET /user` before it is saved as a GitHub connection (`{id, kind: "github", site, apiBase, gh: {host, account}}`, the same type the GitHub mod uses) and chosen in `preferences.reviews.connectionId`. This mod is not per repository.

Review opens a tab in the space the mod is shown in, running the chosen tool in a new worktree named `review-<repo>-<n>-<tool>` of the pull request's repository, with the exact task `Use the review-this skill on <PR url>. <instructions>` (only the first sentence when the box is empty). The pull request's title and body never enter the task. Instructions may span lines; tabs and other control characters are refused on the card, and the whole task is capped at 4000 characters. A second click on a card whose agent exists focuses it and sends nothing.

The repository checkout is, in order: a Mission Control repo binding for `owner/repo` on that machine; `~/workspace/<owner, lower case>/<repo>` when it is the top of a Git checkout whose `origin` is that repository on the same host; the folder given before; else a small dialog asks for the folder once, checks it the same way, saves it in `preferences.reviews.checkouts` and starts the review. Nothing is ever cloned.

## Built from

Ship only `mods/mission-control-reviews/` containing bundled native ESM `main.js`, `mod.json`, self-contained Node ESM `backend.mjs`, local SVG `assets/` and `NOTICE.md`; place this recipe beside `mods/`. Default `props.view` is `panel`; it also serves `setup` and `checkout` dialogs, plus `hideHeader`.

**Access disclosure:** reads/writes Mission Control configuration and launch/session/name journals outside the mod folder. Runs local Node.js 22+, `gh auth token` for the selected account (the token stays in the helper), read-only HTTPS requests to that GitHub API (search, `/user`, GraphQL `nodes`), Git/Python 3 and the selected agent on the reviewing machine. Creates worktrees and sends the review task to that agent. Opens pull request and author links with the system browser.

## Watch out

Never clone. Never send pull request text to the agent. Validate every helper reply strictly and reject it rather than repair it. Search results past the third page of either search are left out and the status line says so.

## Done when

- `herdr-app check <copied-mod-folder>` passes with only this custom mod installed.
- Native clicks prove both sections, links, Refresh, Set up, the checkout dialog, a Review start and the focus-only second click.
