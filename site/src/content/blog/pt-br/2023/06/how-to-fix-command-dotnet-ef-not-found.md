---
title: "Como resolver: dotnet ef not found (dotnet-ef does not exist)"
description: "Resolva o erro 'dotnet-ef does not exist' / 'dotnet ef command not found' instalando a CLI do EF Core como ferramenta global ou local do .NET."
pubDate: 2023-06-11
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "entity-framework"
lang: "pt-br"
translationOf: "2023/06/how-to-fix-command-dotnet-ef-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
> Could not execute because the specified command or file was not found.  
> Possible reasons for this include:  
> -- You misspelled a built-in dotnet command.  
> -- You intended to execute a .NET Core program, but dotnet-ef does not exist.  
> -- You intended to run a global tool, but a dotnet-prefixed executable with this name could not be found on the PATH.

A causa mais provável dessa mensagem de erro é que você não tem a ferramenta **dotnet ef** instalada.

A partir do ASP.NET Core 3, a ferramenta de comando **dotnet ef** não faz mais parte do SDK do .NET Core. Essa mudança permite que o time distribua o dotnet ef como uma ferramenta comum da CLI do .NET, que pode ser instalada como global ou local. Isso vale para todas as distribuições, seja você trabalhando com Visual Studio no Windows ou usando `dotnet` em um Mac ou Ubuntu Linux.

Por exemplo, para conseguir gerenciar migrações ou gerar um **DbContext** via scaffold, instale o **dotnet ef** como ferramenta global digitando o seguinte comando:

```shell
dotnet tool install --global dotnet-ef
```

Se você quiser instalar uma versão específica, pode informar o parâmetro **--version**. Por exemplo:

```shell
dotnet tool install --global dotnet-ef --version 3.*
dotnet tool install --global dotnet-ef --version 5.*
dotnet tool install --global dotnet-ef --version 6.*
dotnet tool install --global dotnet-ef --version 7.*
dotnet tool install --global dotnet-ef --version 8.*
```

## Desinstalar o dotnet-ef

Se você terminou de usar a ferramenta e quer desinstalar o `dotnet-ef`, pode fazer isso com o comando `dotnet tool uninstall`.

```shell
dotnet tool uninstall dotnet-ef --global
```
