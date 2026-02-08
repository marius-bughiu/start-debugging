---
title: "Azure DevOps Fix: .NET Core SDK requires logout or session restart"
description: "How to fix the Azure DevOps build error 'Since you just installed the .NET Core SDK, you will need to logout or restart your session' by switching the build agent specification."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "azure"
---
If you encounter the error "Since you just installed the .NET Core SDK, you will need to logout or restart your session before running the tool you installed" in Azure DevOps, the fix is to switch your build agent specification to `windows-2019`.
