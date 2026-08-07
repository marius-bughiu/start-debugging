---
title: "Microsoft.Testing.Platform 2.3: --report-gh выводит падения тестов прямо в diff пул-реквеста"
description: "Статья в блоге .NET от 2026-08-06 про отчёты MTP показывает набор расширений, ставших стабильными в Microsoft.Testing.Platform 2.3.0: аннотации GitHub Actions, устойчивая к падениям запись TRX и история нестабильности в Azure DevOps."
pubDate: 2026-08-07
tags:
  - "dotnet"
  - "testing"
  - "ci-cd"
  - "github-actions"
  - "msbuild"
lang: "ru"
translationOf: "2026/08/microsoft-testing-platform-2-3-github-actions-annotations"
translatedBy: "claude"
translationDate: 2026-08-07
---

2026-08-06 в блоге .NET вышла статья [Test reporting in Microsoft.Testing.Platform: from red build to root cause](https://devblogs.microsoft.com/dotnet/microsoft-testing-platform-reporting/). Новость здесь не сама статья, а то, какая часть этой истории с отчётами тихо приехала в Microsoft.Testing.Platform 2.3.0 (2026-07-07, последний патч 2.3.3 от 2026-07-28) и в большинстве репозиториев до сих пор выключена по умолчанию.

## Красный job не должен означать пролистывание всего лога

Без дополнительной настройки упавший прогон MTP на раннере GitHub даёт ненулевой код возврата и стену консольного текста. Новый пакет `Microsoft.Testing.Extensions.GitHubActionsReport` вместе с ключом `--report-gh` меняет то, что раннер делает с этими данными: группы лога по сборкам, аннотации `::error`, которые попадают на поля вкладки **Files changed** пул-реквеста, когда позиция в исходниках определяется, сводка job в Markdown, дописываемая в `GITHUB_STEP_SUMMARY`, и записи `::notice` для медленных тестов.

Расширение бездействует, пока переменная окружения `GITHUB_ACTIONS` не равна `true`, поэтому локальный `dotnet test` не затрагивается. Каждая подфункция включена по умолчанию после установки `--report-gh` и может быть отключена по отдельности:

```yaml
- name: Test
  run: dotnet test -- --report-gh --report-gh-slow-test-threshold 30s --report-trx
```

Порог принимает либо просто число секунд, либо значение с суффиксом вроде `90s`, `2m` или `1.5h`. По умолчанию используется `60s`.

## Настройка на весь репозиторий вместо отдельных вызовов

Есть два способа не вставлять флаги в каждый шаг workflow. Подтяните весь набор расширений Microsoft в каждый тестовый проект через `Directory.Build.props`:

```xml
<PropertyGroup>
  <TestingExtensionsProfile>AllMicrosoft</TestingExtensionsProfile>
</PropertyGroup>
```

Затем задайте опции декларативно в `testconfig.json` рядом с тестовым проектом:

```json
{
  "commandLineOptions": {
    "report-trx": true,
    "report-html": true,
    "report-azdo": true,
    "report-azdo-flaky-history": 14
  }
}
```

Если `Microsoft.Testing.Platform.MSBuild` есть в графе зависимостей (он приходит транзитивно с раннерами MSTest, NUnit и xUnit), провайдеры отчётов регистрируются автоматически при установке пакета. Ручные вызовы `builder.AddGitHubActionsProvider()` нужны только тогда, когда вы задали `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>`.

## TRX, переживающий смерть тестового хоста

Изменение, которое я включил бы первым, вообще не является флагом. Начиная с MTP 2.3.0, результаты TRX пишутся на диск по мере прогона, поэтому тестовый хост, упавший в середине набора, всё равно оставляет TRX со всем, что было собрано до падения. Раньше такой сценарий давал пустой каталог результатов и падение CI без единой полезной строки, тот же тупик, из-за которого команды [берут MCP-сервер для binlog, чтобы разбирать сборки](/ru/2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures/).

Имя TRX по умолчанию в 2.3.0 тоже стало детерминированным: `{asm}_{tfm}_{arch}.trx` вместо `<UserName>_<MachineName>_<timestamp>.trx`. Одно это чинит целый класс хрупких glob-шаблонов при выгрузке артефактов.

## Отделяем регрессии от нестабильных тестов в Azure DevOps

На стороне Azure DevOps ключ `--report-azdo-flaky-history 14` запрашивает историю результатов тестов за последние N дней (от 1 до 90) и снабжает падения контекстом нестабильности. В паре с `--report-azdo-demote-known-flaky` падение, превысившее порог нестабильности (по умолчанию 25%), понижается с ошибки до предупреждения, так что настоящая регрессия остаётся единственным красным элементом на странице.

Отчёты HTML, JUnit XML и CTRF JSON тоже появились в 2.3.0 через `--report-html`, `--report-junit` и `--report-ctrf`. Все три помечены как экспериментальные, поэтому зафиксируйте версию MTP, прежде чем вешать их на обязательную проверку. Полные таблицы опций есть в [документации по отчётам MTP](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-test-reports).
