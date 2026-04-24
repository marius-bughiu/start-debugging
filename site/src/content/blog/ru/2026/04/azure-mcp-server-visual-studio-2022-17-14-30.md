---
title: "Azure MCP Server едет внутри Visual Studio 2022 17.14.30, расширение не требуется"
description: "Visual Studio 2022 17.14.30 встраивает Azure MCP Server в workload разработки Azure. Copilot Chat может достучаться до более чем 230 инструментов Azure в 45 сервисах, ничего не устанавливая."
pubDate: 2026-04-22
tags:
  - "visual-studio"
  - "azure"
  - "mcp"
  - "github-copilot"
lang: "ru"
translationOf: "2026/04/azure-mcp-server-visual-studio-2022-17-14-30"
translatedBy: "claude"
translationDate: 2026-04-24
---

[Пост блога Visual Studio](https://devblogs.microsoft.com/visualstudio/azure-mcp-tools-now-ship-built-into-visual-studio-2022-no-extension-required/) от 15 апреля 2026 года похоронил тихое, но значительное изменение: начиная с Visual Studio 2022 версии 17.14.30, Azure MCP Server - часть workload разработки Azure. Без расширения из marketplace, без ручного `mcp.json`, без онбординга на каждую машину. Если у вас установлен workload и вы залогинены в GitHub и Azure, Copilot Chat уже видит более 230 инструментов Azure в 45 сервисах.

## Зачем запекать внутрь

До 17.14.30 поставить Azure MCP Server перед Copilot Chat в VS 2022 означало отдельную установку, JSON-конфиг на пользователя и танец переаутентификации каждый раз, когда запущенный через npx сервер терял токен. Упаковка сервера с workload убирает шаг установки и привязывает auth к существующему Azure account picker IDE, так что тот же логин, который управляет Cloud Explorer, управляет инструментами MCP.

Это также приводит VS 2022 к паритету с VS 2026, который поставляет интеграцию Azure MCP с ноября 2025 года.

## Включение

Сервер едет с workload, но отключен по умолчанию. Чтобы зажечь его:

1. Обновите Visual Studio 2022 до 17.14.30 или выше (Help, Check for Updates).
2. Откройте Visual Studio Installer и подтвердите, что workload разработки Azure установлен.
3. Войдите в GitHub-аккаунт, чтобы Copilot был активен, затем войдите в Azure-аккаунт из account picker в заголовке окна.
4. Откройте Copilot Chat, кликните на иконку гаечного ключа с подписью "Select tools" и включите "Azure MCP Server".

После этого сервер стартует по требованию в первый раз, когда Copilot выбирает инструмент Azure. Проверить это можно из chat prompt:

```text
> #azmcp list resource groups in subscription Production
```

Copilot пройдёт через встроенный сервер и вернёт живой список, в пределах аккаунта, под которым вы залогинены. Тот же диалог гаечного ключа показывает отдельные инструменты, так что можно отключить шумные (например, costs) без отключения всего сервера.

## Что вы реально получаете

Встроенный сервер выставляет ту же tool surface, что задокументирована в [aka.ms/azmcp/docs](https://aka.ms/azmcp/docs), сгруппированную по четырём корзинам:

- **Learn**: спрашивайте вопросы о форме сервиса ("какой tier Azure SQL поддерживает private link со serverless replica"), не покидая IDE.
- **Design and develop**: получайте config-сниппеты и SDK-вызовы, привязанные к ресурсам вашей подписки, а не обобщённые примеры.
- **Deploy**: поднимайте resource groups, Bicep-деплойменты и container apps из чата.
- **Troubleshoot**: тяните запросы Application Insights, стримы логов App Service и статусы pod AKS прямо в разговор.

Чат вроде "staging app service возвращает 502, подтяни последний час сбоев и скажи, что изменилось" теперь выполняется end-to-end без copy paste между вкладками портала.

## Когда standalone-сервер всё ещё имеет смысл

Встроенный build следует за сервисной каденцией VS, которая отстаёт от upstream-релизов `Azure.Mcp.Server`. Если нужен инструмент, приземлившийся на прошлой неделе, зарегистрируйте standalone-сервер рядом со встроенным в `mcp.json`, и Copilot смерджит списки инструментов. Для всех остальных удаление этого config-файла теперь правильный шаг.
