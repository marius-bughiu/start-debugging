---
title: "Solución en Azure DevOps: el SDK de .NET Core requiere cerrar sesión o reiniciar la sesión"
description: "Cómo solucionar el error de compilación en Azure DevOps 'Since you just installed the .NET Core SDK, you will need to logout or restart your session' cambiando la especificación del agente de compilación."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "azure"
lang: "es"
translationOf: "2020/11/azure-devops-fix-since-you-just-installed-the-net-core-sdk-you-will-need-to-logout-or-restart-your-session-before-running-the-tool-you-installed"
translatedBy: "claude"
translationDate: 2026-05-01
---
Si te encuentras con el error "Since you just installed the .NET Core SDK, you will need to logout or restart your session before running the tool you installed" en Azure DevOps, la solución es cambiar la especificación del agente de compilación a `windows-2019`.
