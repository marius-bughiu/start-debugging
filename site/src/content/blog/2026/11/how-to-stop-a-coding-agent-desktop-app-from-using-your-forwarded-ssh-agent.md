---
title: "How to Stop a Coding Agent Desktop App From Using Your Forwarded SSH Agent Keys on Remote Hosts"
description: "The Codex app inside ChatGPT Desktop links any forwarded SSH agent on a remote host to a stable socket that its long-lived app server and every agent command inherit. How the link works, how to check whether your keys are exposed, a dedicated ssh_config alias with ForwardAgent no and IdentityAgent none, why turning forwarding off does not cut a link that is still live, and how to scope keys with ssh-add -c, -t and -h when the agent really needs git."
pubDate: 2026-11-26
template: "how-to"
tags:
  - "ai-agents"
  - "codex"
  - "ssh"
  - "security"
  - "remote-development"
---

**Short answer:** give the desktop app its own host alias in `~/.ssh/config` with `ForwardAgent no` (and `IdentityAgent none` if the agent should not authenticate onward with your local keys at all), put that block above any `Host *` block, and add only that alias under the app's remote connections. Then check the remote host: in the Codex app (ChatGPT Desktop, builds 26.1023.6123.0 through 26.1103.60933 were inspected by the sources below), a bootstrap line links any live forwarded agent socket to `~/.codex/app-server-control/forwarded-ssh-agent.sock`, and the long-lived app server, plus every command the agent runs, uses that path as `SSH_AUTH_SOCK`. Turning forwarding off on your alias does not remove a link that still points at a live socket from another session, so close those sessions or remove the link by hand. If the agent genuinely needs to push to git, give it a separate deploy key on the server instead of your agent, or load your key with `ssh-add -c -t 1h -h github.com`.

## Why a forwarded agent is worse when an agent is on the other end

SSH agent forwarding has always come with a warning. The `ssh_config(5)` entry for `ForwardAgent` says users who can bypass file permissions on the remote host "can access the local agent through the forwarded connection", and that while an attacker cannot extract key material, "they can perform operations on the keys that enable them to authenticate using the identities loaded into the agent." For a human sitting in a terminal, that risk is bounded by who else has root on the box.

A coding agent changes the shape of the risk. The agent is a process you deliberately run as your user on that host, it executes commands chosen by a model, and it reads untrusted text all day: issue bodies, README files, dependency source, web pages. Anything that can steer it into running `ssh git@github.com` or `git push` against a repository you did not intend can now sign with every key in your laptop's agent: your personal GitHub key, the key to the production bastion, the key your 1Password or Secretive agent holds. Nothing crosses the wire that an exfiltration filter would notice, because the private key never leaves your machine. Only signatures do.

That is why this question started showing up in November 2026, after reports on Hacker News, [DEV](https://dev.to/slabb/chatgpt-desktop-forwards-your-ssh-agent-to-the-machines-its-agent-runs-on-your-keys-its-repos-359h) and [PrivacyAffairs](https://www.privacyaffairs.com/chatgpt-desktop-ssh-agent-forwarding/) described how the Codex app inside ChatGPT Desktop hands a forwarded agent to its remote app server.

## What the Codex app actually does on the remote host

The [Codex remote connections docs](https://developers.openai.com/codex/remote-connections) describe the user-facing feature: the app reads concrete host aliases from `~/.ssh/config`, resolves them with OpenSSH, and under Settings > Connections you pick a host and a remote project folder. The app starts the remote Codex app server over SSH through the remote user's login shell. The docs do not mention SSH agents.

The agent part comes from a GitHub history worth reading in order:

1. [openai/codex#22567](https://github.com/openai/codex/issues/22567) (May 2026): a user reported that Remote SSH "does not honor ForwardAgent", which broke `docker buildx build --ssh default`. A commenter found the real cause: the app server is long-lived and keeps the `SSH_AUTH_SOCK` from whichever SSH session first launched it, so after a reconnect it points at a dead socket.
2. [openai/codex#28131](https://github.com/openai/codex/pull/28131) (June 2026): an opt-in `codex app-server proxy --forward-ssh-agent` mode that would refresh a stable `forwarded-ssh-agent.sock` symlink beside the control socket. It was closed without merging.
3. [openai/codex#59694](https://github.com/openai/codex/issues/59694) (opened November 5, 2026, still open at the time of writing): a user quotes the bootstrap the desktop app actually runs on connect (Windows build 26.1023.6123.0, the same logic found statically in 26.1027.3384.0):

```sh
# Bootstrap quoted in openai/codex#59694, Codex App 26.1023.6123.0
if [ -S "${SSH_AUTH_SOCK:-}" ]; then
  ln -sfn -- "$SSH_AUTH_SOCK" \
    "${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock"
elif [ ! -S "${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock" ]; then
  rm -f -- "${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock"
fi
```

The shared app server starts with `SSH_AUTH_SOCK` pointing at that stable path, so every shell command, `git` call and `ssh` call the agent makes inherits it. PrivacyAffairs inspected macOS build 26.1103.60933 (built November 8) and reports that the SSH options the app passes contain no `-A` and no `ForwardAgent=yes`; for OpenAI's own cloud connections it sets `ForwardAgent=no`. So the app does not turn forwarding on by itself. What it does is take a forwarded agent that your config already allowed and make it available to a background daemon that outlives the SSH session, and to an autonomous process you did not think of as "logged in".

The same pattern exists in other tools. VS Code's Remote-SSH extension has its own `remote.SSH.enableAgentForwarding` setting, and anything with an agent mode that runs on the remote side of such a connection (Copilot agent mode, Cursor's remote SSH, Claude Code started in a remote terminal) inherits whatever `SSH_AUTH_SOCK` that remote session has. The fixes below are plain OpenSSH and apply to all of them.

## Check whether your keys are reachable right now

Start on your laptop. `ssh -G` prints the configuration OpenSSH will actually use for an alias, after every `Host` and `Match` block has been applied:

```bash
# OpenSSH 8.9+; output below from OpenSSH_10.3p1 on macOS
ssh -G devbox | grep -iE '^(forwardagent|identityagent|identitiesonly) '
# forwardagent yes      <- the app will have an agent to hand over
```

If you see `forwardagent yes` for the alias you added in the app, the remote side gets your agent. Then see what that agent would sign for:

```bash
ssh-add -l   # every identity listed here is usable from the remote host
```

On the remote host, look for the link and whether it resolves to a live socket:

```bash
# On the remote host, Codex app remote connections
L="${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock"
ls -l "$L" 2>/dev/null || echo "no forwarded agent link"
[ -S "$L" ] && SSH_AUTH_SOCK="$L" ssh-add -l
```

If the last command lists your laptop's keys, any command the agent runs can use them, including `git push` to every repository those keys can write to.

## Give the app its own alias with forwarding off

The cleanest fix is a separate alias that only the desktop app uses. Your interactive `ssh devbox` keeps working as before; the app connects through `devbox-agent`, which never carries your agent.

```ssh-config
# ~/.ssh/config, OpenSSH 8.9+
# Put specific hosts ABOVE "Host *": ssh uses the first value it finds.
Host devbox-agent
    HostName devbox.example.com
    User dev
    ForwardAgent no
    # Optional: do not use the local agent even to log in to devbox.
    IdentityAgent none
    IdentitiesOnly yes
    IdentityFile ~/.ssh/devbox_agent_ed25519

Host devbox
    HostName devbox.example.com
    User dev
    ForwardAgent yes

Host *
    ForwardAgent yes
```

`ForwardAgent no` is the part that matters for the remote host. `IdentityAgent none` goes one step further: the documented value `none` "disables the use of an authentication agent", so the laptop-side `ssh` process authenticates to `devbox` with the single file in `IdentityFile` and never talks to your agent at all. That is useful when your agent is a 1Password or Secretive agent holding a dozen keys and you want the app's connection to know about exactly one.

Then add `devbox-agent` (not `devbox`) in Settings > Connections, and remove the old entry if you had one.

### The ordering trap

OpenSSH takes the first value it finds for each option. A `Host *` block with `ForwardAgent yes` at the top of the file silently wins over a later, more specific `ForwardAgent no`. This was checked with `ssh -G` against a throwaway config on OpenSSH 10.3p1 (macOS):

```bash
# Throwaway config with Host * FIRST, then the specific host
cat > /tmp/cfg <<'EOF'
Host *
    ForwardAgent yes
Host devbox-agent
    HostName devbox.example.com
    ForwardAgent no
EOF
ssh -F /tmp/cfg -G devbox-agent | grep -i '^forwardagent'
# forwardagent yes   <- the specific "no" was ignored
```

With the specific block moved above `Host *`, the same command prints `forwardagent no`. Always confirm with `ssh -G <alias>` after editing; reading the file is not enough when there are `Include` lines or `Match` blocks.

## Turning forwarding off does not cut a live link

This is the gotcha most write-ups miss. Look at the `elif` branch of the bootstrap: when the new connection has no `SSH_AUTH_SOCK`, it removes the stable link only if the link does not resolve to a socket. If the link points at a socket that is still alive, it is left alone.

Running the bootstrap above in a scratch `HOME` on macOS, with a dummy Unix socket standing in for a forwarded agent, shows the behavior directly:

```bash
# Simulating the bootstrap: zsh + /bin/sh on macOS, Python 3 dummy socket
# 1) connect with a forwarded agent A
#    link -> /tmp/agA.DcPi/a.sock   (live)
# 2) reconnect with no SSH_AUTH_SOCK while A is still alive
#    link -> /tmp/agA.DcPi/a.sock   (still live, NOT removed)
# 3) reconnect with no agent after A's socket is gone
#    link removed
```

In practice, step 1 is any earlier connection that carried your agent: the app before you changed the alias, a second desktop client on another machine connected to the same account (the scenario in [#59694](https://github.com/openai/codex/issues/59694)), or an `ssh -A devbox` terminal you left open. As long as that session's forwarded socket exists, the long-running app server keeps signing through it, even after the app reconnects with forwarding off.

So after switching aliases:

```bash
# On the remote host, after disconnecting the app and any ssh -A sessions
L="${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock"
rm -f -- "$L"
# Find leftover forwarded sockets from your user's sessions
# (/tmp/ssh-* on older sshd, ~/.ssh/agent/ on OpenSSH 10.1+)
ls -ld /tmp/ssh-*/agent.* ~/.ssh/agent/* 2>/dev/null
```

Then reconnect from the app through the new alias and run the check from the previous section again. The link should be absent, and `ssh-add -l` against it should fail.

## When the agent really does need git over SSH

Sometimes the reason forwarding was on is legitimate: the agent needs to `git fetch` a private submodule or push a branch. You have three options, from best to most convenient.

**A key that lives on the server and can do one thing.** Generate a key on the remote host and register it as a [GitHub deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys) on the one repository the agent works in, read-only unless it needs to push. The agent can then only touch that repository, and you can revoke it without touching your personal keys.

```bash
# On the remote host
ssh-keygen -t ed25519 -f ~/.ssh/agent_repo_deploy -N "" -C "codex-agent@devbox"
cat >> ~/.ssh/config <<'EOF'
Host github.com
    IdentityFile ~/.ssh/agent_repo_deploy
    IdentitiesOnly yes
    IdentityAgent none
EOF
```

**Scope what you forward.** If you must forward your own agent, load only the key the agent needs and constrain it. All three flags are documented in [`ssh-add(1)`](https://man.openbsd.org/ssh-add):

```bash
# On your laptop, OpenSSH 8.9+ on both ends for -h over a forwarded agent
ssh-add -D                              # drop everything else first
ssh-add -c -t 1h \
  -h "devbox.example.com>git@github.com" \
  ~/.ssh/id_ed25519_github
```

`-c` requires confirmation through `ssh-askpass` before every use, so a surprise `git push` at 3 a.m. becomes a dialog on your screen. `-t 1h` drops the key from the agent after an hour. `-h` is a destination constraint, added in OpenSSH 8.9 and described in [OpenSSH's agent restriction notes](https://www.openssh.org/agent-restrict.html): the key can only be used from the forwarding host to the listed destination, so a hijacked agent on `devbox` cannot use it to log in to your bastion. The man page is explicit about the limit: it does not stop someone with access to the remote `SSH_AUTH_SOCK` from using it "to a permitted destination". Confirmation is the only one of the three that puts a human in front of each signature.

**Use keys that need a touch.** Hardware-backed keys (`ssh-keygen -t ed25519-sk` with a FIDO2 security key) or Secure Enclave keys from an agent such as Secretive require a physical touch per signature. Forwarding them is far less dangerous, because a model cannot press a button on your desk.

## Gotchas and variants

- **Per-use confirmation needs a working askpass.** `ssh-add -c` relies on an `ssh-askpass` program on the machine running the agent. Without one, confirmation cannot be shown, so test with a plain `ssh -T git@github.com` before relying on it.
- **Some agents ignore `-c`.** Agents like 1Password's implement their own approval model, and constraint support (`-h`) varies. Check `ssh-add -l` and your agent vendor's docs; a constraint that the agent silently drops is no constraint.
- **The app server outlives the connection.** Closing the desktop app does not necessarily stop the remote app server. The link check above is the reliable signal, not whether the window is open.
- **Sandboxing does not cover this.** Codex's sandbox restricts file writes and network access by default, and the agent asks before commands that need the network, per OpenAI's [approvals and security docs](https://learn.chatgpt.com/docs/agent-approvals-security). Approving one `git push` approves the signature too. A disposable VM only helps if you also stop forwarding into it.
- **Two clients, one account.** If you connect from two machines to the same remote account and `CODEX_HOME`, the last connection with a live agent wins the link, and the other machine's sessions sign with that agent. Use separate remote accounts or a separate `CODEX_HOME` per client.

## Related reading

The broader version of this problem is keeping any credential out of an agent's reach. The pattern in [keeping API keys out of agent context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/) applies the same "the agent gets a capability, not the secret" thinking to HTTP tokens, and [Claude Code's sandbox credential blocking](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/) covers the local equivalent for Bash. If you move agents into [disposable VMs or containers](/2026/09/run-coding-agents-in-disposable-vms-and-containers/), keep forwarding off for those hosts as well. For the Codex side of provider setup, see [running Codex CLI against Vertex AI](/2026/11/how-to-run-codex-cli-against-google-cloud-vertex-ai/), and for a recent example of a token leaking through agent convenience features, [keeping secrets out of `.claude/settings.local.json`](/2026/11/how-to-keep-secrets-out-of-claude-code-settings-local-json/).

## Sources

- [OpenBSD `ssh_config(5)`](https://man.openbsd.org/ssh_config): `ForwardAgent`, `IdentityAgent`, `IdentitiesOnly`.
- [OpenBSD `ssh-add(1)`](https://man.openbsd.org/ssh-add): `-c`, `-t`, `-h`.
- [OpenSSH agent restriction](https://www.openssh.org/agent-restrict.html).
- [Codex remote connections](https://developers.openai.com/codex/remote-connections).
- [openai/codex#22567](https://github.com/openai/codex/issues/22567), [openai/codex#28131](https://github.com/openai/codex/pull/28131), [openai/codex#59694](https://github.com/openai/codex/issues/59694).
- [PrivacyAffairs: ChatGPT Desktop App Gives Codex Your Forwarded SSH Agent](https://www.privacyaffairs.com/chatgpt-desktop-ssh-agent-forwarding/).
