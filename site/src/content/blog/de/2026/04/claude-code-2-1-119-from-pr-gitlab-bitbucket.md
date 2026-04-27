---
title: "Claude Code 2.1.119 holt PRs aus GitLab, Bitbucket und GitHub Enterprise"
description: "Claude Code v2.1.119 erweitert --from-pr über github.com hinaus. Die CLI akzeptiert nun URLs von GitLab Merge Requests, Bitbucket Pull Requests und GitHub Enterprise PRs, und eine neue prUrlTemplate-Einstellung lenkt das Footer-Badge auf den richtigen Code-Review-Host."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "gitlab"
  - "bitbucket"
lang: "de"
translationOf: "2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket"
translatedBy: "claude"
translationDate: 2026-04-27
---

Das aktuelle Claude-Code-Release v2.1.119 bringt eine kleine, aber überfällige Änderung für Teams jenseits von GitHub: `--from-pr` akzeptiert jetzt URLs von GitLab Merge Requests, Bitbucket Pull Requests und GitHub Enterprise PRs, und eine neue `prUrlTemplate`-Einstellung lenkt das Footer-PR-Badge auf eine eigene Code-Review-URL statt auf github.com. Bis zu diesem Release ging der PR-Review-Flow davon aus, dass jeder Code-Review-Host github.com sei, was die Funktion für jeden Shop auf GitLab oder Bitbucket Cloud umständlich machte.

## Was --from-pr tut, und warum der Host wichtig ist

`--from-pr` ist die Flag für "starte eine Sitzung gegen diesen Pull Request": Sie fügen die PR-URL ein, Claude Code checkt den Head-Branch aus und bereitet die Sitzung mit dem Diff und dem Review-Thread vor. Sie war seit ihrer Einführung der sauberste Weg, eine Agent-Sitzung gezielt auf ein bestimmtes Code-Review zu starten, aber der URL-Parser war an `github.com/owner/repo/pull/<n>` gebunden. Jede URL außerhalb von GitHub fiel durch den Parser, und die Sitzung verlor den Review-Kontext.

v2.1.119 verallgemeinert die URL-Behandlung. Die im Changelog ausdrücklich genannten Formen sind GitLab-Merge-Request-URLs, Bitbucket-Pull-Request-URLs und GitHub-Enterprise-PR-URLs:

```bash
claude --from-pr https://github.com/acme/api/pull/482
claude --from-pr https://gitlab.com/acme/api/-/merge_requests/482
claude --from-pr https://bitbucket.org/acme/api/pull-requests/482
claude --from-pr https://github.acme.internal/acme/api/pull/482
```

Dieselbe Flag, derselbe Flow, vier verschiedene Review-Hosts.

## prUrlTemplate ersetzt den github.com-Footer-Link

Selbst mit funktionierendem `--from-pr` blieb ein Reibungspunkt: Das Footer-Badge, das den aktiven PR anzeigt, war fest auf github.com gesetzt, weil die URL in der CLI hartkodiert war. v2.1.119 fügt eine `prUrlTemplate`-Einstellung hinzu, die dieses Badge stattdessen auf eine eigene Code-Review-URL zeigen lässt. Dasselbe Release weist außerdem darauf hin, dass `owner/repo#N`-Kurzlinks in der Agent-Ausgabe nun den Host Ihres git-Remotes verwenden, statt immer auf github.com zu zeigen, sodass das Umschreiben über die gesamte Oberfläche konsistent ist.

`prUrlTemplate` lebt in `~/.claude/settings.json` wie die übrige Claude-Code-Konfiguration. Das neue Release persistiert außerdem die `/config`-Einstellungen (Theme, Editor-Modus, ausführlicher Modus und Ähnliches) in derselben Datei mit Override-Reihenfolge project/local/policy, sodass eine Organisation `prUrlTemplate` über `~/.claude/settings.policy.json` ausrollen kann und nicht jeder Entwickler es per Hand setzen muss.

## Warum das für .NET-Shops auf GitLab wichtig ist

Die meisten .NET-Teams, die in den letzten Jahren von Azure DevOps weggewechselt sind, sind auf GitHub oder selbst gehostetem GitLab gelandet, oft mit einer langen Reihe interner Repositorys, die zu einer GitHub-Enterprise-Instanz gespiegelt werden, um mit OSS interoperabel zu bleiben. Bisher bedeutete es, Claude Code auf eines dieser Nicht-GitHub-Repositorys zu richten, entweder:

1. Den PR über einen temporären Clone eines github.com-Mirrors hin- und herzuschicken, oder
2. Die Review zu erledigen, indem man den Diff manuell in die Konversation einfügt.

Mit v2.1.119 plus einer in der Policy-Datei der Organisation eingebrannten `prUrlTemplate` funktioniert derselbe `claude --from-pr <url>`-Flow für die gesamte Mischung. Das frühere Release v2.1.113, das die [CLI auf ein natives Binary](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) umgestellt hat, bedeutet, dass auf den Build-Agents, die automatisierte PR-Review-Jobs ausführen, auch keine Node.js-Laufzeit installiert werden muss, was diesen Rollout in streng verwalteten CI-Flotten leichter durchsetzbar macht.

Wenn Sie eine `~/.claude/settings.policy.json` für Ihr Team ausliefern, ist dies die Woche, um die `prUrlTemplate`-Zeile hinzuzufügen. Die vollständigen Release Notes zu v2.1.119 finden Sie im [Claude Code Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
