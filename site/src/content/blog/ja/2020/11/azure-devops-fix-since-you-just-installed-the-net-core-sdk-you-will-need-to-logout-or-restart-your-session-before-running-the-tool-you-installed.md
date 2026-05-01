---
title: "Azure DevOps の対処方法: .NET Core SDK でログアウトまたはセッション再起動が必要"
description: "Azure DevOps のビルドエラー 'Since you just installed the .NET Core SDK, you will need to logout or restart your session' を、ビルドエージェントの指定を切り替えて修正する方法。"
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "azure"
lang: "ja"
translationOf: "2020/11/azure-devops-fix-since-you-just-installed-the-net-core-sdk-you-will-need-to-logout-or-restart-your-session-before-running-the-tool-you-installed"
translatedBy: "claude"
translationDate: 2026-05-01
---
Azure DevOps で "Since you just installed the .NET Core SDK, you will need to logout or restart your session before running the tool you installed" というエラーが出た場合の対処方法は、ビルドエージェントの指定を `windows-2019` に切り替えることです。
