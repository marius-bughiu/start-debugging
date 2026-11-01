---
title: "Fix: Copilot agent commands fail with \"Operation not permitted\" or a network denial after you enable local sandboxing"
description: "Run /sandbox policy <command> to see what the sandbox blocked, then grant the path or host it needs, update Copilot CLI to 1.0.103 for the localhost, proxy and Linux fixes, and only bypass a command on purpose."
pubDate: 2026-10-24
template: error-page
tags:
  - "errors"
  - "github-copilot"
  - "ai-agents"
  - "copilot-cli"
  - "sandboxing"
---

If an agent command that worked yesterday now dies with `Operation not permitted`, `EPERM`, `Access is denied`, a proxy `403`, or a TLS error right after you turned on Copilot local sandboxing, the sandbox is doing its job: the command reached for a path, host or port the policy does not grant. Run `/sandbox policy <the command>` to see what it gets, then grant exactly the missing path (`/sandbox config`, Filesystem) or host (Network), and update to Copilot CLI 1.0.103, because five of the most common "the sandbox broke my build" reports (localhost on macOS, DNS on Linux, `NO_PROXY`, `/add-dir`, commands killed after 10 seconds) are fixed bugs, not configuration. Bypass a single command only when you accept that it runs with your real credentials.

Everything below was checked against Copilot CLI 1.0.103 (October 22, 2026), its `copilot help sandbox` text, the CLI changelog, and the `github/copilot-cli` issue tracker. The macOS error strings were reproduced with `sandbox-exec`, the same Seatbelt backend Copilot uses.

## The error in context

The sandbox does not print a friendly "blocked by Copilot" message from inside the command. The child process gets an ordinary OS denial and reports it in its own words, so the same root cause looks different in every tool. On macOS a write outside the granted paths, and a direct connection to a localhost port, look like this:

```text
sh: /Users/marius/.cache/mytool/x: Operation not permitted
touch: /Users/marius/.cache/mytool/y: Operation not permitted
curl: (7) Failed to connect to 127.0.0.1 port 8765 after 0 ms: Couldn't connect to server
connect EPERM 127.0.0.1:8765 - Local (0.0.0.0:0)
PermissionError: [Errno 1] Operation not permitted
```

The last two lines are the same denied localhost connection seen from Node and from Python. A JVM build says `java.net.SocketException: Operation not permitted` when its client cannot reach the Gradle or Kotlin daemon it just started. The kernel log has the honest version:

```text
Sandbox: java(5913) deny(1) network-outbound remote:*:53774
```

On Windows the same class of failure shows up as `Access is denied` from PowerShell or `cmd`, and on Linux a host that cannot build the sandbox fails before your command runs at all:

```text
Bubblewrap: network.proxy requires unprivileged user and network namespaces, which this host refused (unshare --user --net exited with exit status: 1).
```

Network denials through the sandbox's egress proxy surface as `CONNECT tunnel failed, response 502`, a `403` from the proxy, `OpenSSL SSL_connect: SSL_ERROR_SYSCALL`, or `could not resolve host`.

## Why sandboxing turns working commands into denials

Without the sandbox, an approved shell command runs with your whole user account. With it, Copilot hands a policy to [Microsoft eXecution Container (MXC)](https://github.com/microsoft/mxc), which enforces it with Seatbelt on macOS, bubblewrap on Linux and ProcessContainer on Windows. Anything the policy does not grant fails at the syscall. The causes, ranked by how often they show up:

1. **A path outside the grant.** By default a command gets read/write on the working directory, `.git` and temp, read-only on the rest of the repo, and scoped access to dev-tool caches. A sibling repo, a custom cache, or a file in your home directory is not included.
2. **Localhost or a private-network service.** Test databases in Docker, dev servers, build daemons and emulators all live on loopback. That is the most restricted area of the policy and the one that changed most between versions.
3. **A host that your allowlist does not list.** One Allow rule turns the network into an allowlist, and every unmatched host fails.
4. **The credential proxy.** git, `gh` and masked variables go through a local HTTPS proxy with its own CA. Tools that ignore its CA bundle, pin certificates or need HTTP/2 fail with TLS or auth errors.
5. **The host cannot sandbox at all.** Missing Linux prerequisites, an AppArmor policy that blocks `unshare`, or an old Windows build. In that state every sandboxed command fails, and Copilot does not fall back to running unsandboxed.

## Minimal repro

The smallest setup that reproduces cause 1 and cause 2 on macOS is a sandboxed session plus anything that writes to your home directory or connects to a local port:

```jsonc
// ~/.copilot/settings.json, Copilot CLI 1.0.103
{
  "sandbox": {
    "enabled": true
  }
}
```

```bash
# Copilot CLI 1.0.103, macOS: ask the agent to run either of these
touch ~/.cache/mytool/state            # Operation not permitted
psql -h 127.0.0.1 -U postgres -c '\l'  # connection denied unless local network is allowed
```

If you want to see the mechanism without spending model requests, this reproduces the exact same errors with the Seatbelt primitive Copilot builds on. It is a demonstration of the OS behavior, not Copilot's generated profile:

```bash
# macOS 27, sandbox-exec (the Seatbelt backend MXC uses)
mkdir -p ~/.sbtest
python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &
prof='(version 1)(allow default)
      (deny file-write* (subpath "'"$HOME"'/.sbtest"))
      (deny network-outbound (remote ip "localhost:*"))'
sandbox-exec -p "$prof" sh -c 'touch ~/.sbtest/y; curl -sS http://127.0.0.1:8765/'
# touch: /Users/you/.sbtest/y: Operation not permitted
# curl: (7) Failed to connect to 127.0.0.1 port 8765 after 0 ms: Couldn't connect to server
kill %1; rm -rf ~/.sbtest
```

## Fix, in detail

### 1. Update Copilot CLI before you touch the policy

Local sandboxing went generally available on October 7, 2026, and the two weeks since then shipped a long list of fixes for exactly these symptoms. From the [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md):

| Version | Fix |
|---|---|
| 1.0.96 | `/add-dir` grants sandbox access to added directories for the current session |
| 1.0.100 | Local network access allowed by default; DNS works on Linux hosts using the `systemd-resolved` stub at `127.0.0.53`; host-rule traffic honors `HTTPS_PROXY`/`HTTP_PROXY`; credential-proxy certificate failures are explained |
| 1.0.101 | macOS sandboxed commands can connect directly to localhost TCP services when local access is on and no host filters apply |
| 1.0.102 | Sandboxed commands keep running past 10 seconds on Linux; traffic honors `NO_PROXY` and `ALL_PROXY` |
| 1.0.103 | `dnx` reuses .NET/NuGet grants; Windows shims like `npm.cmd` get the same grants as `npm`; ACP sessions honor sandbox settings |

```bash
# Copilot CLI 1.0.103, October 2026
npm install -g @github/copilot@latest
copilot --version
```

The 1.0.102 fix deserves a callout. On Linux before that release, any sandboxed command running longer than about 10 seconds was killed with `SIGKILL` and reported only `Failed with exit code -1`, with no error message. The CLI started `bwrap --die-with-parent` from a pool thread, and Linux delivers the parent-death signal when that thread exits ([copilot-cli#5176](https://github.com/github/copilot-cli/issues/5176)). If your test suite "randomly dies" in a sandboxed session on an older build, that is the reason, and no policy change will help.

Restart the session after updating. Running sessions keep the old binary and the old policy.

### 2. Ask the sandbox what it blocked

Do not guess from the error text. Copilot will tell you the effective policy:

```text
/sandbox status
/sandbox policy
/sandbox policy npm test
/sandbox policy ./gradlew build
```

`/sandbox policy` prints the effective paths and network settings for the current directory. Read its **Notes** section: settings that could not be applied (a managed rule overriding yours, a path that does not exist on Linux) are listed there. `/sandbox policy <command>` previews the extra dev-tool grants a specific command would get without running it.

When that is not enough, the per-command policy Copilot actually generated is written under `~/.copilot/session-state/<session>/policies/*.json`, and on macOS the kernel logs every denial:

```bash
# macOS: watch Seatbelt denials while the agent runs the failing command
log stream --style compact --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny"'
```

A `deny(1) file-write-create /path` line tells you the path to grant. A `deny(1) network-outbound remote:*:5432` line tells you it is a loopback or local-network problem, not a filesystem one.

### 3. Grant the path, not the whole home directory

For `Operation not permitted`, `EACCES` or `Access is denied` on a file, open `/sandbox config`, go to **Filesystem > User-configured paths**, press `A`, and add the absolute path as **Read/Write** or **Read-Only**. Wildcards are not supported, and a directory grant covers its subtree. The same thing in settings:

```jsonc
// ~/.copilot/settings.json, Copilot CLI 1.0.103
{
  "sandbox": {
    "enabled": true,
    "userPolicy": {
      "filesystem": {
        "readwritePaths": ["/Users/marius/src/shared-lib", "/Users/marius/.cache/mytool"],
        "readonlyPaths": ["/Users/marius/src/design-tokens"]
      }
    }
  }
}
```

For a one-off, `/add-dir /Users/marius/src/shared-lib` grants read/write for the current session only, from 1.0.96 on. Before that, `/add-dir` added the folder to the agent's context but not to the sandbox, which is why a sibling-repo build kept failing after you "added" it ([copilot-cli#5076](https://github.com/github/copilot-cli/issues/5076)).

Three path cases catch people:

- **Moved caches configured inside the repo.** `allowDevToolAccess` follows caches you moved with an environment variable (`NUGET_PACKAGES`, `GRADLE_USER_HOME`, `npm_config_cache`) or with the tool's config file in your home directory. It deliberately ignores config files in the repository you are working in, so a `nuget.config` in the repo that points packages at `D:\nuget` gets no grant. Grant that path explicitly.
- **Turning off "Include working directory".** That also drops the `.git` grant, so every `git status` and `git commit` fails until you grant the repository manually.
- **A denied path that did not exist.** Copilot creates a directory at every missing denied path before the command starts. If you see `Failed to prepare denied sandbox path`, the command never ran: check the path and that you can create directories there.

### 4. Fix localhost and local-network denials

This is the one most people hit first, because test suites talk to Postgres in Docker, Redis, a dev server, or a build daemon on `127.0.0.1`. Work through it in this order:

1. **Check the setting, not the docs.** `userPolicy.network.allowLocalNetwork` was off by default through 1.0.98 and is on by default from 1.0.100. The GitHub docs still describe the old CLI default as off, while the 1.0.103 help text says on. Your saved settings win either way, so read `/sandbox policy` and turn **Allow local network** on in the Network tab if it says blocked.
2. **On macOS, update to 1.0.101.** Before that release, `allowLocalNetwork: true` opened ingress but never allowed host loopback, so the Seatbelt profile still denied `localhost:*`. Only proxy-aware HTTP clients got through, via the built-in proxy. Gradle and Kotlin daemons, Postgres and Prisma, Temporal test servers and supertest all failed with `EPERM` ([copilot-cli#5105](https://github.com/github/copilot-cli/issues/5105)).
3. **Remove host rules if you need direct loopback on macOS.** The 1.0.101 fix applies only "when no host filters apply". Once you have any Allow or Deny host rule, direct connections to localhost go back to being blocked, and only traffic through the proxy reaches loopback. If you need both an allowlist and a local database, keep the database tests in a separate, unfiltered session or run them outside the agent.
4. **On Linux, expect the proxy path only.** Each sandbox gets a private network namespace, so sandboxed processes cannot connect to the host's localhost directly. HTTP clients that honor `HTTP_PROXY` reach it through the built-in proxy, subject to host rules. A raw TCP client like `psql` or a JDBC driver does not. Point those at the host's LAN address instead, or run the dependency inside the same sandboxed command.
5. **On Windows, turn Allow local network on whenever you use git/`gh` auth or masked variables.** Without it, sandboxed commands cannot reach Copilot's own local proxy, and credential-backed git fails even though nothing local is involved.

### 5. Fix denials to external hosts

If `npm ci` or `dotnet restore` fails only against some registries, you have an allowlist. As soon as one Allow host rule exists, every unmatched host is blocked, Deny beats Allow, and `*.example.com` matches subdomains but not `example.com` itself. List both:

```jsonc
// ~/.copilot/settings.json, Copilot CLI 1.0.103
{
  "sandbox": {
    "userPolicy": {
      "network": {
        "allowOutbound": true,
        "allowedHosts": [
          "registry.npmjs.org",
          "github.com", "api.github.com", "codeload.github.com",
          "objects.githubusercontent.com",
          "nuget.org", "*.nuget.org"
        ]
      }
    }
  }
}
```

Run the real install once with the rule set in place and read the bypass prompt or the proxy `403` to find the host you missed. Behind a corporate proxy, the sandbox's egress proxy chains to your upstream proxy. Before 1.0.102 it ignored `NO_PROXY`, so internal hosts were sent to the corporate proxy and came back as `CONNECT tunnel failed, response 502` or `SSL_ERROR_SYSCALL` ([copilot-cli#5199](https://github.com/github/copilot-cli/issues/5199)). On Windows, host rules only apply to programs that honor proxy settings.

### 6. Fix TLS and authentication errors from the credential proxy

git, `gh` and masked environment variables are authenticated by a local proxy that swaps a fake token for the real one in HTTPS headers. A tool that ignores the temporary CA bundle Copilot supplies reports a certificate or auth error. On macOS and Windows, install the CA:

```text
/sandbox ca create
/sandbox ca trust
```

That changes OS trust (login Keychain on macOS, the machine root store with an admin prompt on Windows), so do it on purpose. After adding a masked host, run `/sandbox ca rotate`. Tools that use HTTP/2, pin certificates, use client certificates or sign requests can still fail with the CA trusted. Leave those to a deliberate bypass, or [keep their keys behind a separate credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/).

### 7. Fix a Linux host that cannot sandbox at all

If every command fails and the session started with a warning, the host is missing a prerequisite. `copilot help sandbox` lists them: `bwrap` 0.5.0+, `slirp4netns`, util-linux 2.35+ (`unshare` with `--map-current-user` and `--keep-caps`, plus `nsenter`), `iptables`, `ip6tables` and both `-restore` binaries on `PATH`, and read/write on `/dev/net/tun`. `iptables` often lives in `/usr/sbin`, which is not on a normal user's `PATH`.

On Ubuntu with `kernel.apparmor_restrict_unprivileged_userns=1`, `bwrap` has an AppArmor profile that allows user namespaces and `unshare` does not, so Copilot's preflight (`unshare --user --map-current-user --keep-caps --net -- sh -c :`) is refused even though a plain `bwrap` test passes. The fix a Copilot maintainer gave in [copilot-cli#5052](https://github.com/github/copilot-cli/issues/5052), confirmed working on Ubuntu 26.04, gives `unshare` its own profile instead of loosening the sysctl:

```text
# /etc/apparmor.d/unshare  (Ubuntu 26.04, AppArmor 4)
abi <abi/4.0>,
include <tunables/global>

profile unshare /usr/bin/unshare flags=(unconfined) {
  userns,
  include if exists <local/unshare>
}
```

```bash
sudo apparmor_parser -r /etc/apparmor.d/unshare
/usr/bin/unshare --user --map-current-user --keep-caps --net -- sh -c : && echo ok
```

### 8. Decide whether a bypass is the fix

When Copilot thinks the sandbox caused a failure, it offers to rerun that one command outside it. Approved retries are labeled **sandbox relaxed** (files and processes relaxed, network still enforced) or **sandbox bypassed** (fully unsandboxed). A full bypass also skips the credential proxy, so the command sees real secrets. That is fine for a one-off you read yourself. It is not a fix for a command the agent will run fifty times a day; grant the path or host instead. For unattended runs, set `"allowBypass": false` so a missing grant fails loudly, as described in [turning on Copilot local sandboxing and restricting what an agent can touch](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/).

## Gotchas and lookalikes

- **`/sandbox policy` lying about local network.** On builds before 1.0.86, `/sandbox policy` showed local network as blocked even when the setting was on and applied ([copilot-cli#4854](https://github.com/github/copilot-cli/issues/4854)). Trust the behavior, and update.
- **Windows working directory on `D:\`.** With the working directory on a non-system drive, sandboxed PowerShell can fail to list or stat directories with `Access is denied` and start in `C:\WINDOWS\System32\WindowsPowerShell\v1.0`. Reading a file by full path still works. The policy is correct; the cause is open MXC enforcement issues ([copilot-cli#5207](https://github.com/github/copilot-cli/issues/5207)). Until it is fixed, keep sandboxed repos on `C:` or use absolute paths like `git -C "D:\src\app" status`.
- **`/ide` reports "No active IDE workspaces found".** Under the macOS sandbox, `kill(pid, 0)` on the IDE process returns `EPERM`, which the discovery code reads as a dead process ([copilot-cli#4909](https://github.com/github/copilot-cli/issues/4909)). That is not a grant you can add.
- **Remote MCP servers are never sandboxed**, and the built-in file read/edit tools are only checked in software. If a file edit succeeds while a shell `cp` of the same file fails, that asymmetry is expected.
- **The sandbox inherits your environment.** It does not cause failures here, but it is the reason a command that "works in the sandbox" can still read `AWS_ACCESS_KEY_ID`. Mask it or unset it.
- **A heavier fence might be simpler.** If your test suite needs Docker, several local ports and a dozen hosts, you may be fighting the wrong tool. [Running the agent in a disposable VM or container](/2026/09/run-coding-agents-in-disposable-vms-and-containers/) gives it a whole machine to break instead of a policy to negotiate.

## Related

- [How to turn on Copilot local sandboxing and restrict which directories, hosts and credentials an agent can touch](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/)
- [How to lock down a coding agent's network egress with a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/)
- [How to keep API keys out of a coding agent's context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/)
- [How to run a coding agent in a disposable VM or container instead of on your laptop](/2026/09/run-coding-agents-in-disposable-vms-and-containers/)
- [How to define a GitHub Copilot CLI dynamic workflow and run it from CI](/2026/10/how-to-define-a-github-copilot-cli-dynamic-workflow-and-run-it-from-ci/)

## Sources

- [Using local sandboxing](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/using-local-sandboxing) (GitHub Docs)
- [Configuring local sandbox settings](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings) (GitHub Docs)
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md), versions 1.0.86 to 1.0.103
- [copilot-cli#5105: macOS sandbox blocks Gradle daemon connection](https://github.com/github/copilot-cli/issues/5105)
- [copilot-cli#5176: Linux sandboxed commands killed after ~10 s](https://github.com/github/copilot-cli/issues/5176)
- [copilot-cli#5052: Ubuntu 26.04 sandbox preflight and the AppArmor `unshare` profile](https://github.com/github/copilot-cli/issues/5052)
- [copilot-cli#5199: sandbox egress proxy ignores `NO_PROXY`](https://github.com/github/copilot-cli/issues/5199)
- [copilot-cli#5207: Windows non-system drive enumeration](https://github.com/github/copilot-cli/issues/5207)
- [Microsoft eXecution Container (MXC)](https://github.com/microsoft/mxc)
- `copilot help sandbox`, Copilot CLI 1.0.103
