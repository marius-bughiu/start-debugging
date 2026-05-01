---
title: "Решение в Azure DevOps: .NET Core SDK требует выхода из системы или перезапуска сессии"
description: "Как исправить ошибку сборки Azure DevOps 'Since you just installed the .NET Core SDK, you will need to logout or restart your session', изменив спецификацию агента сборки."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "azure"
lang: "ru"
translationOf: "2020/11/azure-devops-fix-since-you-just-installed-the-net-core-sdk-you-will-need-to-logout-or-restart-your-session-before-running-the-tool-you-installed"
translatedBy: "claude"
translationDate: 2026-05-01
---
Если в Azure DevOps вы столкнулись с ошибкой "Since you just installed the .NET Core SDK, you will need to logout or restart your session before running the tool you installed", решение - изменить спецификацию агента сборки на `windows-2019`.
