# Changelog

## 0.1.4

**The docs stop being a suggestion.** 0.1.3 added `fabapp_docs` and asked the agent, in the MCP `instructions`, to
call it first. An instruction is something a model is free to skip, and the cost of skipping this one is a schema
with an invented field type, or access rules that lock every user out of their own records — which fails closed and
silently rather than loudly.

`fabapp_write_definition` now REFUSES until `fabapp_docs` has been called in the session. It does not check that the
agent understood anything; it checks that the contract entered its context before it wrote a schema, which is the
most a server can enforce and the thing that was missing.

Only that tool is gated. Reading, deploying and creating a project encode no part of the contract, and a gate there
would be friction bought with nothing.

**And the closed field-type list now travels in the tool description itself.** A tool description is the one text
every MCP client puts in front of the model — read even by an agent that skipped the docs and the instructions — so
the part that is most often guessed wrong (`select` is not a type; `enum` is) belongs there too.

## 0.1.3

**`fabapp_docs`** — the platform's own contract, as an MCP tool, and the opening now tells the agent to read it first.

An agent arriving through this server knew nothing about the platform it had just been given write access to. It got
`Account <id> · scope: read write` and seven tool descriptions: no field types (a closed list — anything else is
refused), no access grammar (the only gate on an app's data), no project layout. The documentation was published and
good; nothing pointed at it, so the agent had to already know it existed.

It is fetched LIVE from the host rather than shipped as a copy in this package. A copy goes stale against a contract
that changes, and an agent reading a stale copy writes a schema the server then refuses — which reads as the platform
being broken rather than as the docs being old.

Requires a control-plane from 2026-08-26 or later, where the docs also gained the access grammar in full
(`owner_field`, `owner_in`, `owner_via`, the closed defaults). Before that the tool works but the corpus it returns
describes ownership in three sentences.

## 0.1.2

**`fabapp create "<name>"`** — a project and its first surface, without a browser.

This was the last human-only step in a chain that is otherwise open to machines. A token granted `write` could
write the schema, write the code and publish, but not create the container to put any of it in, so every agent
workflow began with "now go and click New project in the Studio".

The MCP server gains `fabapp_create_project` (write scope) for the same reason.

**Fixed — `fabapp deploy` never worked.** `PUT /code` accepted a machine and `GET /code` did not, and deploy reads
the current set *first*, so it can lay your local edits over whatever the server has now rather than over a stale
workspace. That read answered 401 before the write was ever attempted. Nobody had hit it because until the Studio's
`/cli` approval screen shipped, no CLI token existed to try it with. Both sides of the compare-and-swap now take
the same credential.

**A surface that fails leaves the project alive.** Creating is two calls. If the second one fails, the project is
reported with its id and kept — deleting somebody's just-created project because a follow-up call failed is a worse
outcome than an empty project they can finish by hand.

Requires a control-plane from 2026-08-26 or later.

## 0.1.1

**0.1.0 did not work when installed.** npm publishes the `bin` as a SYMLINK
(`node_modules/.bin/fabapp -> ../@fabappai/cli/src/index.mjs`), and the "am I the main module" guard compared
`import.meta.url` against `process.argv[1]` — which through the link is the LINK's path, not the file's. They never
matched, `main()` never ran, and the command exited with code **0 printing nothing**, which is the quietest
possible way to fail: it looks like it worked.

The whole suite passed because it ran `node src/index.mjs`, the DIRECT path, where the comparison holds. Testing
the file is not testing the artifact.

⚠️ **This version was published BY HAND, so it carries no provenance attestation.** Publishing by hand was the
trade: 0.1.0 was live and broken, and every `npx @fabappai/cli` was failing silently while the pipeline was stuck.

The pipeline was stuck on a one-word mismatch worth writing down, because the error names neither field. The
Trusted Publisher entry for this package had its **GitHub organisation set to `fabappai`** — which is the *npm*
scope — while the repository lives at `fabappbr/cli`. Actions signs a claim saying `fabappbr/cli`, npm compares it
against `fabappai/cli`, and an identity it does not recognise is refused as **`404 Not Found - PUT`**, not as a 403.
So it reads exactly like "this package does not exist", which sends you looking at the package, the scope and the
token — everywhere except the one field that is wrong. The two orgs being near-homographs is what made it survive
three attempts. Corrected to `fabappbr`; the next release goes through the pipeline and carries provenance again.

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
