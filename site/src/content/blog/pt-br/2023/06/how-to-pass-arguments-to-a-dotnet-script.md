---
title: "Como passar argumentos para um dotnet script"
description: "Aprenda a passar argumentos para um dotnet script usando o separador -- e a acessá-los pela coleção Args."
pubDate: 2023-06-12
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
lang: "pt-br"
translationOf: "2023/06/how-to-pass-arguments-to-a-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ao usar **dotnet script** você pode passar argumentos informando-os após **--** (dois hífens). Depois você acessa os argumentos no script pela coleção **Args**.

Vamos a um exemplo. Suponha que tenhamos o seguinte arquivo de script **myScript.csx**:

```cs
Console.WriteLine($"Inputs: {string.Join(", ", Args)}");
```

Podemos passar parâmetros para esse script da seguinte forma:

```shell
dotnet script myScript.csx -- "a" "b"
```
