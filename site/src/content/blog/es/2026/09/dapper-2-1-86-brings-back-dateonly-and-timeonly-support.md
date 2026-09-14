---
title: "Dapper 2.1.86 recupera DateOnly y TimeOnly, dos años después de retirarlos"
description: "Dapper 2.1.86 vuelve a habilitar el mapeo integrado de DateOnly y TimeOnly para parámetros, miembros y escalares, con los errores del desplazamiento de columna y del default(T) silencioso corregidos. Qué cambió, qué medí y qué significa para tus type handlers personalizados."
pubDate: 2026-09-14
tags:
  - "dapper"
  - "dotnet"
  - "csharp"
lang: "es"
translationOf: "2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support"
translatedBy: "claude"
translationDate: 2026-09-14
---

Dapper 2.1.86 llegó a NuGet el 2026-09-12, y lo más destacado es una sola línea en las [notas de la versión](https://github.com/DapperLib/Dapper/releases/tag/2.1.86): "Re-enable DateOnly/TimeOnly support, fixing the defects that got it disabled". Si llevas arrastrando un `SqlMapper.TypeHandler<DateOnly>` desde .NET 6, esta es la versión que te permite eliminarlo.

## Cómo el soporte de DateOnly llegó, se rompió y desapareció

El mapeo nativo de `DateOnly`/`TimeOnly` llegó por primera vez en 2.1.37 con [#2051](https://github.com/DapperLib/Dapper/pull/2051) en marzo de 2024. En cuestión de semanas, usuarios de 2.1.44 se toparon con [#2072](https://github.com/DapperLib/Dapper/issues/2072): una columna `datetime` mapeada a una propiedad `DateOnly` fallaba con `Error parsing column 1 (FromDate=Ed - String)`, lo que parecía un error de desfase por uno porque el error mostraba el valor de la columna equivocada. En abril de 2024 la funcionalidad se excluyó de la compilación ([#2080](https://github.com/DapperLib/Dapper/pull/2080)), y todas las versiones de 2.1.66 a 2.1.79 se publicaron sin ella.

[El PR #2228](https://github.com/DapperLib/Dapper/pull/2228) corrige las causas de fondo en lugar de los síntomas:

- Una columna cuyo tipo reportado necesita una conversión (un `datetime` a `DateOnly`) ya no pasa por `GetFieldValue<T>`. Ese era el fallo de #2072.
- Las rutas de miembros, escalares y `Parse<T>` ahora convierten `DateOnly`/`TimeOnly` desde y hacia `DateTime`/`TimeSpan` en ambas direcciones. Esto importa porque los proveedores no coinciden: Npgsql 10 empaqueta una columna `date` como `DateOnly`, mientras que SqlClient y Npgsql 9 empaquetan `DateTime` ([#2226](https://github.com/DapperLib/Dapper/issues/2226)).
- `QuerySingle<DateOnly>` ya no devuelve `default(T)` sin ningún error ([#2227](https://github.com/DapperLib/Dapper/issues/2227)).

## Antes y después, medido

Ejecuté la misma aplicación basada en archivo contra 2.1.79 y 2.1.86 en .NET SDK 10.0.302 con `Microsoft.Data.Sqlite` 10.0.12:

```csharp
#:package Dapper@2.1.86
#:package Microsoft.Data.Sqlite@10.0.12
#:property PublishAot=false
using Dapper;
using Microsoft.Data.Sqlite;

using var c = new SqliteConnection("Data Source=:memory:");
c.Open();

c.ExecuteScalar<string>("select @d", new { d = new DateOnly(2026, 9, 14) });
c.ExecuteScalar<string>("select @t", new { t = new TimeOnly(9, 30) });
c.QuerySingle<DateOnly>("select '2026-09-14'");
c.QuerySingle<Row>("select 'x' as Name, '2026-09-14' as Due");

public class Row { public string Name { get; set; } = ""; public DateOnly Due { get; set; } }
```

| Llamada | 2.1.79 | 2.1.86 |
| --- | --- | --- |
| Parámetro `DateOnly` | `NotSupportedException`: no se puede usar como valor de parámetro | `2026-09-14` |
| Parámetro `TimeOnly` | `NotSupportedException` | `09:30:00` |
| `QuerySingle<DateOnly>` | `0001-01-01`, sin error | `2026-09-14` |
| Miembro `DateOnly` | `DataException`: error al analizar la columna 1 | `2026-09-14` |

La fila del escalar es la que debe preocuparte si sigues en una versión anterior: datos incorrectos, sin excepción.

## Qué pasa con tu type handler existente

La solución habitual era un `SqlMapper.TypeHandler<DateOnly>` registrado al inicio. Con ese mismo handler registrado en 2.1.86, mi prueba mostró que el mapeo integrado toma el control para parámetros y miembros `DateOnly`: los métodos `SetValue` y `Parse` del handler nunca se llamaron. Solo la ruta escalar `QuerySingle<DateOnly>` seguía llamando a `Parse`. En 2.1.79 el mismo handler se ejecutaba en las tres rutas.

Si tu handler solo convertía entre `DateOnly` y `DateTime`, no pierdes nada. Si hacía algo personalizado, como escribir fechas como cadenas `yyyyMMdd` o enteros, ahora se omite en la ruta de parámetros, y la base de datos recibe lo que el proveedor haga con un `DateOnly` sin convertir. Prueba antes de actualizar.

## Alcance

El soporte se compila para los targets `net8.0` y `net10.0` del paquete. Las compilaciones `netstandard2.0` y `net461` no lo tienen, y la suite de pruebas explícitamente no espera que funcione con el antiguo `System.Data.SqlClient`. Usa `Microsoft.Data.SqlClient`.

La misma versión también retira los feeds de MyGet y AppVeyor: Dapper ahora publica solo en nuget.org, mediante Trusted Publishing (OIDC). Si un `nuget.config` todavía apunta al antiguo feed de MyGet para compilaciones preliminares, elimínalo.
