---
title: "Как установить dotnet script"
description: "dotnet script позволяет запускать C#-скрипты (.CSX) из .NET CLI. Единственное требование — наличие .NET 6 или новее на машине. Установить dotnet-script глобально можно следующей командой: Затем для выполнения файла-скрипта достаточно вызвать dotnet script <file_path>, как в примере ниже: Как..."
pubDate: 2023-08-29
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
  - "dotnet"
lang: "ru"
translationOf: "2023/08/how-to-install-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
`dotnet script` позволяет запускать C#-скрипты (`.CSX`) из .NET CLI. Единственное требование — установленный .NET 6 или новее.

Установить dotnet-script глобально можно следующей командой:

```bash
dotnet tool install -g dotnet-script
```

Затем для выполнения файла-скрипта достаточно вызвать `dotnet script <file_path>`, как в примере ниже:

```bash
dotnet script startdebugging.csx
```

## Как инициализировать новый dotnet script

Если вы только начинаете и хотите создать новый файл dotnet script, используйте команду `init`, чтобы сгенерировать проект скрипта.

```bash
dotnet script init startdebugging.csx
```

Будет создан файл скрипта вместе с launch-конфигурацией, нужной для отладки скрипта в VS Code. Имя файла опционально: без указания будет использовано `main.csx` по умолчанию.

```plaintext
. 
├── .vscode 
│   └── launch.json 
├── startdebugging.csx 
└── omnisharp.json
```

## Неявные using-директивы

В dotnet script по умолчанию подключены некоторые пространства имён, аналогично функции implicit usings, к которой вы привыкли в проектах .NET SDK. Ниже полный список namespace, доступных в dotnet-script неявно.

```cs
System
System.IO
System.Collections.Generic
System.Console
System.Diagnostics
System.Dynamic
System.Linq
System.Linq.Expressions
System.Text
System.Threading.Tasks
```
