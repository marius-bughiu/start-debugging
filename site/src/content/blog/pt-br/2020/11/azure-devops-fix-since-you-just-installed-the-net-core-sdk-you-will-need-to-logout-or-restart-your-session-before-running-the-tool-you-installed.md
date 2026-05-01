---
title: "Correção no Azure DevOps: o SDK do .NET Core exige logout ou reinício da sessão"
description: "Como corrigir o erro de build no Azure DevOps 'Since you just installed the .NET Core SDK, you will need to logout or restart your session' alterando a especificação do agente de build."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "azure"
lang: "pt-br"
translationOf: "2020/11/azure-devops-fix-since-you-just-installed-the-net-core-sdk-you-will-need-to-logout-or-restart-your-session-before-running-the-tool-you-installed"
translatedBy: "claude"
translationDate: 2026-05-01
---
Se você se deparar com o erro "Since you just installed the .NET Core SDK, you will need to logout or restart your session before running the tool you installed" no Azure DevOps, a correção é alterar a especificação do agente de build para `windows-2019`.
