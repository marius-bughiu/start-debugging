---
title: "Agent Framework PyPI 1.26.1 and 1.26.2 Were Malicious, and the GitHub Repo Is Offline"
description: "Two unauthorized agent-framework releases on PyPI ran a credential stealer from a .pth file on every Python start. Microsoft has taken the microsoft/agent-framework repository offline. Here is who is affected, how to check, and what it means for the .NET packages."
pubDate: 2026-11-28
tags:
  - "agent-framework"
  - "python"
  - "security"
  - "supply-chain"
  - "dotnet"
---

On November 25, 2026, Microsoft published a [repository update](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-repository-update/) for Microsoft Agent Framework that is really an incident notice. Two versions of the Python meta-package `agent-framework`, **1.26.1** and **1.26.2**, were uploaded to PyPI on November 17 without authorization, and both carried credential-stealing code. Both are gone from PyPI, and `github.com/microsoft/agent-framework` now returns 404: Microsoft took the repository offline as a precaution and has given no date for bringing it back. If you followed the [1.28 .NET release notes](/2026/11/agent-framework-1-28-a2a-hosting-returns-messages-only/) through GitHub links, those links are dead for now.

## What the two wheels actually did

The advisory, [PYSEC-2026-4388](https://osv.dev/vulnerability/PYSEC-2026-4388), says both releases were wheel-only repackagings of the legitimate 1.26.0 wheel with one addition: a `.pth` file. Python's `site` module executes `import` lines in any `.pth` file in `site-packages` at interpreter startup, so the payload ran on every `python` invocation in that environment, whether or not your code ever imported `agent_framework`. A test runner, a linting step, or an unrelated script in the same virtualenv was enough.

The payload forked a background process and collected environment variables matching names like `TOKEN`, `SECRET`, `KEY`, `AZURE`, `AWS`, `GITHUB` and `OPENAI`, credential files (`~/.azure`, `.npmrc`, `.netrc`, `.git-credentials`, `pip.conf`, Docker config), other processes' `/proc/*/environ`, Azure managed identity tokens via IMDS, and Azure DevOps OIDC tokens. Version 1.26.2 also requested GitHub Actions OIDC tokens. The data was POSTed to a `webhook.site` URL. In other words, it was built for CI agents and cloud workloads.

## Checking an environment

The indicator files are distinct per version:

- 1.26.1: `agent_framework_meta.pth` and `agent_framework_meta/_telemetry.py`
- 1.26.2: `af_runtime_diag.pth` and `af_runtime_diag.py`

A quick sweep of a virtualenv, a container image layer, or a CI cache:

```bash
# version actually installed
pip show agent-framework | grep -i '^version'

# indicator files anywhere under site-packages
python -c "import site; print('\n'.join(site.getsitepackages()))" \
  | xargs -I{} find {} -maxdepth 2 \
      \( -name 'agent_framework_meta.pth' -o -name 'af_runtime_diag.pth' \
         -o -name 'af_runtime_diag.py' -o -path '*agent_framework_meta/_telemetry.py' \)

# lockfiles in a repo (uv.lock and poetry.lock put the version on the next line)
grep -rn -A1 'agent-framework' --include='*.lock' --include='requirements*.txt' . \
  | grep -E '1\.26\.[12]'
```

Do not stop at the live environment. PyPI removing the files does not touch copies already sitting in pip caches, Docker layers, Artifactory or Azure Artifacts upstream proxies, or `uv` caches.

## If it was installed

Microsoft's guidance is blunt: treat the machine, container, or CI job as compromised. Rotate every credential the environment could reach (cloud identities, CI/CD and package registry tokens, API keys, Git credentials), rebuild from a clean image rather than downgrading in place, purge the versions from internal mirrors, and review cloud and CI audit logs from November 17 onward.

If you never installed either version, pin to the last good release and stay there until Microsoft says otherwise:

```toml
# pyproject.toml
dependencies = [
  "agent-framework==1.26.0",
]
```

## What it means for .NET

The notice states that the .NET packages and Semantic Kernel are not affected, and other Agent Framework Python packages were not either. On NuGet, `Microsoft.Agents.AI` is still listed through 1.28.0. The practical cost for .NET developers is the missing repository: no samples, no issue tracker, no release notes, and no source to step into until it returns. Microsoft says the framework "has not been discontinued" and points questions to its Discord or Azure Support.

The defensive habits carry over to any package manager: lock exact versions (NuGet's `packages.lock.json` with `RestoreLockedMode` in CI), let a new release age before a bot bumps it, and scope CI credentials so that one bad package cannot read every secret the runner has.
