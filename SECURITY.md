# Security

## Reporting a vulnerability

Write to **security@fabapp.com**. Do not open a public issue for a vulnerability — a report on the tracker is
readable by everybody, including whoever would use it, before there is a fix to install.

We acknowledge within **2 business days** and give an initial assessment within **7**. You decide whether you want
public credit. There is no bounty programme at the moment, and we would rather say so than leave the question open.

## What this package is, in terms of risk

It **holds a credential** and **talks to somebody's backend**. Everything below follows from those two sentences.

- **Zero dependencies.** Every package in the graph could reach both of those things.
- **The system keychain first**, a `0600` file only as a fallback — and the fallback is **said out loud**. A tool
  that quietly drops to a worse place teaches you it is always safe.
- **Device flow (RFC 8628).** No long-lived key is shown to a human or typed into a terminal.
- **Separate scopes.** `read` is the default; writing is an explicit grant.
- **Scoped to an account**, not to the identity.
- **Published through Trusted Publishing (OIDC)** with `--provenance`: there is no long-lived npm token anywhere.

## What it never does

- **It does not write outside the project folder.** A path coming from the server that escapes the root is refused.
- **It does not delete.** A file that disappeared is reported, never removed from the app.
- **It does not keep an integration secret on disk.** Connectors and integrations are managed on the platform.

Verify a release:

```bash
npm audit signatures
npm view @fabappai/cli dist.integrity
```
