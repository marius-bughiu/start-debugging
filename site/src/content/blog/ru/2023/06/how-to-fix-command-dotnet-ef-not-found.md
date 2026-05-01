---
title: "Как исправить: dotnet ef not found (dotnet-ef does not exist)"
description: "Исправьте ошибку 'dotnet-ef does not exist' / 'dotnet ef command not found', установив EF Core CLI как глобальный или локальный инструмент .NET."
pubDate: 2023-06-11
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "entity-framework"
lang: "ru"
translationOf: "2023/06/how-to-fix-command-dotnet-ef-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
> Could not execute because the specified command or file was not found.  
> Possible reasons for this include:  
> -- You misspelled a built-in dotnet command.  
> -- You intended to execute a .NET Core program, but dotnet-ef does not exist.  
> -- You intended to run a global tool, but a dotnet-prefixed executable with this name could not be found on the PATH.

Самая вероятная причина этой ошибки - у вас не установлен инструмент **dotnet ef**.

Начиная с ASP.NET Core 3, инструмент командной строки **dotnet ef** больше не входит в состав .NET Core SDK. Это изменение позволяет команде распространять dotnet ef как обычный инструмент .NET CLI, устанавливаемый глобально или локально. Это справедливо для всех дистрибутивов, независимо от того, работаете ли вы с Visual Studio на Windows или используете `dotnet` на Mac либо Ubuntu Linux.

Например, чтобы управлять миграциями или сгенерировать **DbContext**, установите **dotnet ef** как глобальный инструмент следующей командой:

```shell
dotnet tool install --global dotnet-ef
```

Если нужна конкретная версия, укажите параметр **--version**. Например:

```shell
dotnet tool install --global dotnet-ef --version 3.*
dotnet tool install --global dotnet-ef --version 5.*
dotnet tool install --global dotnet-ef --version 6.*
dotnet tool install --global dotnet-ef --version 7.*
dotnet tool install --global dotnet-ef --version 8.*
```

## Удаление dotnet-ef

Если вы закончили работу с инструментом и хотите удалить `dotnet-ef`, это можно сделать командой `dotnet tool uninstall`.

```shell
dotnet tool uninstall dotnet-ef --global
```
