---
title: "Как передать аргументы в dotnet script"
description: "Узнайте, как передавать аргументы в dotnet script с помощью разделителя -- и обращаться к ним через коллекцию Args."
pubDate: 2023-06-12
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
lang: "ru"
translationOf: "2023/06/how-to-pass-arguments-to-a-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
При использовании **dotnet script** аргументы можно передавать, указывая их после **--** (двух дефисов). Затем доступ к этим аргументам в скрипте осуществляется через коллекцию **Args**.

Рассмотрим пример. Предположим, что у нас есть следующий файл скрипта **myScript.csx**:

```cs
Console.WriteLine($"Inputs: {string.Join(", ", Args)}");
```

Мы можем передать параметры этому скрипту так:

```shell
dotnet script myScript.csx -- "a" "b"
```
