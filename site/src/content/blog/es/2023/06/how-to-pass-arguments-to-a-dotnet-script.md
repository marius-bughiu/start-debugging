---
title: "Cómo pasar argumentos a un dotnet script"
description: "Aprende a pasar argumentos a un dotnet script usando el separador -- y a acceder a ellos a través de la colección Args."
pubDate: 2023-06-12
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
lang: "es"
translationOf: "2023/06/how-to-pass-arguments-to-a-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
Cuando usas **dotnet script** puedes pasar argumentos especificándolos después de **--** (dos guiones). Luego puedes acceder a esos argumentos en el script mediante la colección **Args**.

Veamos un ejemplo. Supongamos que tenemos el siguiente archivo de script **myScript.csx**:

```cs
Console.WriteLine($"Inputs: {string.Join(", ", Args)}");
```

Podemos pasar parámetros a este script de la siguiente manera:

```shell
dotnet script myScript.csx -- "a" "b"
```
