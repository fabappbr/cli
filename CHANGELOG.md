# Changelog

## 0.1.1

**0.1.0 did not work when installed.** npm publishes the `bin` as a SYMLINK
(`node_modules/.bin/fabapp -> ../@fabappai/cli/src/index.mjs`), and the "am I the main module" guard compared
`import.meta.url` against `process.argv[1]` — which through the link is the LINK's path, not the file's. They never
matched, `main()` never ran, and the command exited with code **0 printing nothing**, which is the quietest
possible way to fail: it looks like it worked.

The whole suite passed because it ran `node src/index.mjs`, the DIRECT path, where the comparison holds. Testing
the file is not testing the artifact.

The guard now resolves the symlink with `realpathSync`, and there are three tests that **pack, install and call the
binary** — what a user does. Mutation-verified: I reintroduced 0.1.0's exact defect and all three failed. CI and
publish no longer check `node src/index.mjs`.

## 0.1.0

The first release. Seven commands and an MCP server.

    fabapp login    authorises the machine through the device flow (RFC 8628)
    fabapp link     links a directory to a project
    fabapp pull     brings the definition down to disk
    fabapp push     sends back what is on disk
    fabapp dev      runs the app locally, on the platform's template
    fabapp deploy   uploads what you edited and publishes
    fabapp status   which account and which project
    fabapp logout   forgets the token on this machine
    fabapp mcp      MCP server over stdio

**Zero dependencies, and that is a security decision.** It holds a credential and talks to your backend; every
package in the graph could reach both. The system keychain is reached through the binary the OS already ships
(`security` on macOS, `secret-tool` on Linux) rather than a native npm package — a credential vault is the last
place you want compiled code from a registry.

**Two things it will not do**, and they are the ones with mutation-verified tests: `link` checks access BEFORE
writing, and `pull`/`deploy` REPORT a file that disappeared instead of deleting it. A sync that destroys work
nobody asked it to manage is worse than no sync at all.

Requires the Builder plan or above.
