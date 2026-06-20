---
title: "Сервер MCP для Binlog позволяет ИИ читать ваши логи MSBuild"
description: "Microsoft выпустила Microsoft.AITools.BinlogMcp 2026-06-17 -- сервер MCP, предоставляющий 15 инструментов, чтобы Claude или Copilot диагностировали сбои сборки и медленные targets прямо из файла .binlog."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
lang: "ru"
translationOf: "2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds"
translatedBy: "claude"
translationDate: 2026-06-20
---

2026-06-17 Microsoft выпустила [сервер MCP для Binlog](https://devblogs.microsoft.com/dotnet/msbuild-binlog-mcp-server/) -- сервер MCP, который разбирает бинарные логи MSBuild и предоставляет ИИ-ассистенту 15 специализированных инструментов для их исследования. Идея проста: вместо того чтобы открывать многомегабайтный `.binlog` в MSBuild Structured Log Viewer и вручную пробираться сквозь вложенные targets, вы спрашиваете "почему моя сборка упала?", и модель идёт и читает лог за вас.

## Почему binlog -- правильная поверхность

Бинарный лог -- это запись наивысшей точности, которую создаёт MSBuild. Он фиксирует каждый target, задачу, вычисление свойства и item, а также исходные файлы, встроенные во время сборки. Именно эта детализация делает его мучительным для чтения вручную, и именно её модель хорошо умеет запрашивать. Поместив анализатор за Model Context Protocol, один и тот же лог работает в любом клиенте MCP: Claude Code, Copilot в VS Code или Visual Studio.

Сгенерируйте его обычным способом:

```bash
dotnet build /bl:build-a.binlog
```

## Подключение к клиенту MCP

Сервер публикуется как dotnet-инструмент `Microsoft.AITools.BinlogMcp`. В VS Code вы направляете на него `mcp.json` через stdio:

```json
{
  "servers": {
    "binlog-mcp": {
      "type": "stdio",
      "command": "dotnet",
      "args": ["tool", "run", "Microsoft.AITools.BinlogMcp"]
    }
  }
}
```

Если вы хотите, чтобы модель открывала конкретный лог при запуске, передайте его после разделителя `--`:

```json
{
  "args": ["tool", "run", "Microsoft.AITools.BinlogMcp", "--", "--binlog", "msbuild.binlog"]
}
```

Visual Studio и VS Code также могут подтянуть его через плагин `dotnet-msbuild` из маркетплейса `dotnet/skills`, который обнаруживает сервер автоматически, так что JSON можно полностью пропустить.

## 15 инструментов, сгруппированных по тому, что вы реально спрашиваете

Инструменты делятся на четыре задачи. Для диагностики красной сборки есть `binlog_overview` (статус, длительность, число ошибок и проектов), `binlog_errors`, `binlog_warnings` с фильтром по коду и `binlog_search`, выполняющий полнотекстовые запросы на DSL StructuredLog. Выделяется `binlog_explain_property`: он прослеживает, откуда на самом деле взялось значение свойства, так что вопрос вроде "почему `TargetFramework` здесь установлен в net8.0?" получает цепочку вычисления вместо догадки.

Для медленных сборок `binlog_expensive_projects`, `binlog_expensive_targets` и `binlog_expensive_tasks` сортируют по затраченному времени. А `binlog_compare` сравнивает два лога, и именно он, как я ожидаю, оправдает себя:

> Сравни `build-a.binlog` и `build-b.binlog`. Какие свойства MSBuild и версии пакетов изменились?

Этот один промпт заменяет утомительное построчное сравнение, которое вы делаете, когда сборка работает на вашей машине и падает в CI.

Это часть более широкого подхода Microsoft -- оборачивать диагностику .NET в MCP, чтобы агенты могли ею управлять. Сервер живёт в [`dotnet/skills`](https://github.com/dotnet/skills); сообщайте о проблемах там. Если у вас есть нестабильная сборка CI, застрявшая в логе, который никто не хочет открывать, это способ с наименьшими усилиями навести на неё модель.
