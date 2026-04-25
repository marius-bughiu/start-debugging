---
title: "How to fix: dotnet ef not found (dotnet-ef does not exist)"
description: "Fix the 'dotnet-ef does not exist' / 'dotnet ef command not found' error by installing the EF Core CLI as a global or local .NET tool."
pubDate: 2023-06-11
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "entity-framework"
---
> Could not execute because the specified command or file was not found.  
> Possible reasons for this include:  
> – You misspelled a built-in dotnet command.  
> – You intended to execute a .NET Core program, but dotnet-ef does not exist.  
> – You intended to run a global tool, but a dotnet-prefixed executable with this name could not be found on the PATH.

The most likely reason for this error message is that you don’t have the **dotnet ef** tool installed.

Starting with ASP.NET Core 3, the **dotnet ef** command tool is no longer part of the .NET Core SDK. This change allows the team to ship dotnet ef as a regular .NET CLI tool that can be installed as either a global or local tool. This is valid for all distributions, whether you’re working with Visual Studio on Windows, or you’re using `dotnet` on a Mac or Ubuntu Linux.

For example, to be able to manage migrations or scaffold a **DbContext**, install **dotnet ef** as a global tool typing the following command:

```shell
dotnet tool install --global dotnet-ef
```

If you want to install a specific version, you can specify the **--version** parameter. For example:

```shell
dotnet tool install --global dotnet-ef --version 3.*
dotnet tool install --global dotnet-ef --version 5.*
dotnet tool install --global dotnet-ef --version 6.*
dotnet tool install --global dotnet-ef --version 7.*
dotnet tool install --global dotnet-ef --version 8.*
```

## Uninstall dotnet-ef

If you’re done with the tool and are looking to uninstall `dotnet-ef`, you can do so using the `dotnet tool uninstall` command.

```shell
dotnet tool uninstall dotnet-ef --global
```
