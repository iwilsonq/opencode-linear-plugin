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

## Load it

Run `bun install`, then add the package path to `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["/path/to/opencode-linear-plugin"]
}
```

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
5. In the details dialog: `l` lists the links in the description and opens
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
