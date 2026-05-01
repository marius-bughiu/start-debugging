---
title: "Azure DevOps Fix: .NET Core SDK erfordert Abmeldung oder Sitzungsneustart"
description: "Wie Sie den Azure-DevOps-Build-Fehler 'Since you just installed the .NET Core SDK, you will need to logout or restart your session' beheben, indem Sie die Build-Agent-Spezifikation umstellen."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "azure"
lang: "de"
translationOf: "2020/11/azure-devops-fix-since-you-just-installed-the-net-core-sdk-you-will-need-to-logout-or-restart-your-session-before-running-the-tool-you-installed"
translatedBy: "claude"
translationDate: 2026-05-01
---
Wenn Sie in Azure DevOps auf den Fehler "Since you just installed the .NET Core SDK, you will need to logout or restart your session before running the tool you installed" stoßen, besteht die Lösung darin, die Spezifikation Ihres Build-Agents auf `windows-2019` umzustellen.
