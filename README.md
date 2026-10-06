# opencode-linear-plugin — PROTOTYPE

Throwaway prototype. Question: is a Linear ticket list in the OpenCode TUI
useful, and can it start agent sessions from a ticket?

## What it does

- Lists your open assigned Linear tickets. Duplicates are hidden.
- Groups tickets by state, project, or cycle.
- Selects the ticket for the current git branch first (`sam/eng-123` →
  `ENG-123`).
- Shows the ticket description as markdown in a dialog, with a picker for
  the links in it.
- Starts an agent session for a ticket, with the ticket as context.
- Prompts for a Linear personal API key on first run and stores it in plugin
  storage.

## Install

### Requirements

- OpenCode v2 (the `opencode2` CLI). The plugin is pinned to v2.0.1.
- [Bun](https://bun.sh).
- macOS. Links open with `open`, and copying uses `pbcopy` and `osascript`.
- A Linear personal API key. Create one in Linear under Settings → Security
  & access → Personal API keys.
- Optional: the GitHub CLI (`gh`), logged in. Only `y` (copy PRs) needs it.

### Steps

1. Clone the repo and install the dependencies:

   ```sh
   git clone https://github.com/iwilsonq/opencode-linear-plugin.git
   cd opencode-linear-plugin
   bun install
   ```

2. Check your OpenCode version:

   ```sh
   opencode2 --version
   ```

   If it is not v2.0.1, pin the plugin packages to your version. A version
   mismatch crashes the panel. For example, for v2.0.5:

   ```sh
   bun add @opencode/plugin@2.0.5
   bun add -d @opencode/theme@2.0.5
   ```

3. Add the plugin to `~/.config/opencode/cli.json`. Use the absolute path to
   the clone:

   ```json
   {
     "plugins": ["/path/to/opencode-linear-plugin"]
   }
   ```

   To set options, use an object entry instead:

   ```json
   {
     "plugins": [
       {
         "package": "/path/to/opencode-linear-plugin",
         "options": { "workspaceRoot": "~/code" }
       }
     ]
   }
   ```

   | Option | Default | Use |
   |---|---|---|
   | `workspaceRoot` | `~/projects` | The folder that contains your repos. `w` lists the repos in it, and the agent searches it for the repos a ticket touches. |

4. Check that OpenCode finds the plugin:

   ```sh
   opencode2 plugin list
   ```

   The list shows the plugin path with the version `local`.

5. Start `opencode2` (restart it if it is already running) and run
   `/linear`. Paste your Linear API key when it asks. The plugin stores the
   key in OpenCode's plugin storage, and does not ask again.

### Update

Run `git pull` and `bun install` in the clone, then restart `opencode2`.

### Remove

Delete the plugin entry from `~/.config/opencode/cli.json`, then restart
`opencode2`.

### Troubleshooting

- **`/linear` does not appear:** run `opencode2 plugin list`. If the plugin
  is missing, check the path in `cli.json`. OpenCode loads local plugins from
  `tui.ts` in the package root.
- **The panel crashes with an error about `context.theme`:** the plugin
  packages do not match your OpenCode version. Repeat step 2.
- **A Linear error shows in the list:** check that the API key is valid and
  has not been revoked. The plugin has no command to change a stored key
  yet.
- **`y` says it could not check a ticket:** run `gh auth status` to check that
  the GitHub CLI is logged in and can read the repo.

## Use it

1. Run `opencode2`.
2. Run `/linear` (also in the palette). Enter a Linear personal API key on
   first run. In a session, the tickets open in the side panel. Anywhere
   else, they open as a full page.
3. In the list: `↑`/`↓` selects, `enter` or a click shows details, `g`
   changes grouping, `o` opens the ticket in the browser, `r` refetches,
   `f` toggles fullscreen (panel only), `q` closes. `/linear` toggles the
   tickets.
4. `w` starts a session for the selected ticket. Pick where (the workspace
   root lets the agent find the repos; the last repo used for the ticket's
   Linear project is listed first), Implement or Plan only, and an optional
   note. The session gets the ticket, its relations and linked PRs, and
   instructions to find the repos and set up the ticket's branch from `main`
   or the blocking ticket's PR branch. The branch name comes from Linear, so
   it follows your Linear Git settings. The workspace root is `~/projects`;
   set the `workspaceRoot` plugin option to change it.
5. To share PRs for review: `space` marks a ticket, `shift+↑`/`shift+↓`
   marks while moving, `a` marks or unmarks the whole group, and `x` clears
   all marks. `y` copies
   the open, non-draft PRs linked to the marked tickets (or the selected
   ticket) as a rich-text list of PR titles linked to their URLs, with line
   counts (`(+140 -27)`), ready to paste into Slack. It needs the GitHub CLI (`gh`) logged in, and macOS.
   `c` copies the ticket IDs (`ENG-1, ENG-4`). `?` asks the agent about the
   tickets: edit the suggested question, then it goes to the current session
   (queued if the agent is busy), or to a new session from the home page.
6. In the details dialog: `l` lists the links in the description and opens
   the one you pick, `o` opens the ticket, `esc` closes.

Run `bun test` for the tests.

## Notes

- OpenCode loads local plugins from `tui.ts` and `server.ts` in the package
  root, not from `package.json` `exports`.
- Keep `@opencode/plugin` and `@opencode/theme` pinned to the installed
  `opencode2` version. The theme shape changes between versions, and a
  mismatch crashes the panel.
- The markdown style is built from the plugin's own `@opentui/core`.
  `@opencode/theme`'s `generateSyntax` bundles a second copy of
  `@opentui/core`, and its `SyntaxStyle` does not match the host's.
- OpenTUI makes a clickable terminal link (OSC 8) only for URLs of 512
  bytes or less. The terminal then finds longer URLs in the wrapped screen
  text and cuts them at the line break. The `l` link picker opens the full
  URL instead.
- Linear escapes markdown characters in bare URLs (`c\_d`), and OpenTUI keeps
  the backslash in the link. `unescapeBareUrls` removes the escapes before
  rendering.
- The agent list comes from `client.agent.list`, not the TUI's agent cache.
  The cache is empty for directories that the TUI has not opened.
- Biome's a11y rules are off. They target DOM elements, not OpenTUI boxes.
- Links open with macOS `open`.
