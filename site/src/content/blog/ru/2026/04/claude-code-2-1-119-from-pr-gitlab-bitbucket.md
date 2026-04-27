---
title: "Claude Code 2.1.119 подтягивает PR из GitLab, Bitbucket и GitHub Enterprise"
description: "Claude Code v2.1.119 расширяет --from-pr за пределы github.com. CLI теперь принимает URL merge request из GitLab, pull request из Bitbucket и PR из GitHub Enterprise, а новая настройка prUrlTemplate направляет бейдж в подвале на нужный хост code review."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "gitlab"
  - "bitbucket"
lang: "ru"
translationOf: "2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket"
translatedBy: "claude"
translationDate: 2026-04-27
---

Свежий релиз Claude Code, v2.1.119, привозит небольшое, но запоздалое изменение для команд за пределами GitHub: `--from-pr` теперь принимает URL merge request из GitLab, URL pull request из Bitbucket и URL PR из GitHub Enterprise, а новая настройка `prUrlTemplate` направляет бейдж PR в подвале на пользовательский URL code review вместо github.com. До этого релиза процесс ревью PR предполагал, что любой хост code review это github.com, что делало возможность неудобной для любой команды на GitLab или Bitbucket Cloud.

## Что делает --from-pr и почему важен хост

`--from-pr` это флаг для «запусти сессию против этого pull request»: вы вставляете URL PR, Claude Code переключается на head-ветку и подготавливает сессию с diff и тредом ревью. С момента появления это был самый чистый способ запустить агентскую сессию, нацеленную на конкретное ревью кода, но парсер URL был привязан к `github.com/owner/repo/pull/<n>`. Любой URL не из GitHub проваливался мимо парсера, и сессия теряла контекст ревью.

v2.1.119 обобщает обработку URL. Формы, которые changelog называет напрямую, это URL merge request из GitLab, URL pull request из Bitbucket и URL PR из GitHub Enterprise:

```bash
claude --from-pr https://github.com/acme/api/pull/482
claude --from-pr https://gitlab.com/acme/api/-/merge_requests/482
claude --from-pr https://bitbucket.org/acme/api/pull-requests/482
claude --from-pr https://github.acme.internal/acme/api/pull/482
```

Тот же флаг, тот же поток, четыре разных хоста ревью.

## prUrlTemplate заменяет ссылку подвала на github.com

Даже с работающим `--from-pr` оставалась одна неудобная деталь: бейдж в подвале, показывающий активный PR, был привязан к github.com, потому что URL был жёстко зашит в CLI. v2.1.119 добавляет настройку `prUrlTemplate`, которая вместо этого направляет этот бейдж на пользовательский URL code review. Тот же релиз отмечает, что короткие ссылки `owner/repo#N` в выводе агента теперь используют хост вашего git-remote, а не указывают всегда на github.com, так что переписывание единообразно по всему интерфейсу.

`prUrlTemplate` живёт в `~/.claude/settings.json` как и остальная конфигурация Claude Code. Новый релиз также сохраняет настройки `/config` (тему, режим редактора, verbose и подобные) в том же файле с порядком переопределения project/local/policy, так что организация может раздать `prUrlTemplate` через `~/.claude/settings.policy.json` и избавить разработчиков от необходимости настраивать его вручную.

## Почему это важно для .NET-команд на GitLab

Большинство .NET-команд, ушедших с Azure DevOps за последние годы, осели на GitHub или self-hosted GitLab, часто с длинным хвостом внутренних репозиториев, зеркалируемых в инстанс GitHub Enterprise ради совместимости с OSS. До сих пор направить Claude Code на один из таких не-GitHub репозиториев означало:

1. Прогонять PR через временный клон зеркала на github.com, или
2. Делать ревью, вставляя diff в разговор вручную.

С v2.1.119 и `prUrlTemplate`, прописанным в policy-файле организации, тот же поток `claude --from-pr <url>` работает для всего этого набора. Более ранний релиз v2.1.113, переведший [CLI на нативный бинарник](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), означает, что на агентах сборки, выполняющих автоматическое ревью PR, не нужно ставить runtime Node.js, что делает развёртывание проще для строго управляемых парков CI.

Если вы раздаёте `~/.claude/settings.policy.json` для своей команды, на этой неделе самое время добавить строку `prUrlTemplate`. Полные release notes для v2.1.119 в [changelog Claude Code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
