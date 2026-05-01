---
title: "SQLite-net No parameterless constructor defined for this object en ExecuteQuery"
description: "Cómo arreglar el error 'no parameterless constructor defined' en SQLite-net al usar ExecuteQuery con tipos primitivos como string o int."
pubDate: 2023-09-01
updatedDate: 2023-11-05
tags:
  - "sqlite"
lang: "es"
translationOf: "2023/09/sqllitenet-no-parameterless-constructor-defined-for-this-object-on-executequery"
translatedBy: "claude"
translationDate: 2026-05-01
---
Lo más probable es que estés intentando recuperar una sola columna de una tabla de tu base de datos pasando algo similar a `SELECT <column_name> FROM <table_name>` a `ExecuteQuery<string>` o `ExecuteQuery<int>`.

El problema es que `ExecuteQuery<string>` espera un tipo con un constructor sin parámetros, y `string` no cumple ese requisito.

Hay dos soluciones posibles:

## Solución 1: usa el tipo de la tabla

Deja tu consulta SQL tal cual, seleccionando una sola columna, pero al llamar a `ExecuteQuery` asegúrate de proporcionar el tipo asociado a tu tabla. No te preocupes demasiado por el rendimiento de la consulta en este caso: solo se recuperará y rellenará en tus objetos esa columna específica; el resto de propiedades se ignorará.

Después, puedes usar LINQ para seleccionar tu `string`.

```cs
cmd.ExecuteQuery<MyTableType>().Select(t => t.MyColumnName).ToArray();
```

## Solución 2: usa un DTO específico para tu consulta

Si no te gusta usar el tipo asociado a la tabla, siempre puedes definir un DTO personalizado para esta consulta concreta y usarlo en su lugar. Recuerda que debe tener un constructor público sin parámetros.

```cs
public class MyQueryDto
{
    public string MyColumnName { get; set; }
}
```

Y luego pásalo al método `ExecuteQuery` y, opcionalmente, selecciona tu columna en un array de strings después.

```cs
cmd.ExecuteQuery<MyQueryDto>().Select(t => t.MyColumnName).ToArray();
```
