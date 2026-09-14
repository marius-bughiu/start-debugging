---
title: "Dapper 2.1.86 возвращает DateOnly и TimeOnly спустя два года после их удаления"
description: "Dapper 2.1.86 снова включает встроенное сопоставление DateOnly и TimeOnly для параметров, членов и скалярных значений, с исправленными ошибками смещения столбца и тихого default(T). Что изменилось, что я измерил и что это значит для ваших собственных обработчиков типов."
pubDate: 2026-09-14
tags:
  - "dapper"
  - "dotnet"
  - "csharp"
lang: "ru"
translationOf: "2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support"
translatedBy: "claude"
translationDate: 2026-09-14
---

Dapper 2.1.86 появился в NuGet 2026-09-12, и главный пункт в нём занимает одну строку в [примечаниях к выпуску](https://github.com/DapperLib/Dapper/releases/tag/2.1.86): "Re-enable DateOnly/TimeOnly support, fixing the defects that got it disabled". Если вы со времён .NET 6 таскаете за собой `SqlMapper.TypeHandler<DateOnly>`, этот выпуск позволяет его удалить.

## Как поддержка DateOnly появилась, сломалась и исчезла

Нативное сопоставление `DateOnly`/`TimeOnly` впервые появилось в 2.1.37 через [#2051](https://github.com/DapperLib/Dapper/pull/2051) в марте 2024 года. Уже через несколько недель пользователи 2.1.44 столкнулись с [#2072](https://github.com/DapperLib/Dapper/issues/2072): столбец `datetime`, сопоставленный со свойством `DateOnly`, падал с `Error parsing column 1 (FromDate=Ed - String)`. Это выглядело как ошибка на единицу, потому что сообщение показывало значение не того столбца. В апреле 2024 года возможность исключили из компиляции ([#2080](https://github.com/DapperLib/Dapper/pull/2080)), и все выпуски с 2.1.66 по 2.1.79 выходили без неё.

[PR #2228](https://github.com/DapperLib/Dapper/pull/2228) устраняет первопричины, а не симптомы:

- Столбец, чей заявленный тип требует преобразования (`datetime` в `DateOnly`), больше не проходит через `GetFieldValue<T>`. Именно это вызывало падение из #2072.
- Пути для членов, скалярных значений и `Parse<T>` теперь преобразуют `DateOnly`/`TimeOnly` в `DateTime`/`TimeSpan` и обратно. Это важно, потому что провайдеры ведут себя по-разному: Npgsql 10 упаковывает столбец `date` как `DateOnly`, а SqlClient и Npgsql 9 упаковывают `DateTime` ([#2226](https://github.com/DapperLib/Dapper/issues/2226)).
- `QuerySingle<DateOnly>` больше не возвращает `default(T)` без ошибки ([#2227](https://github.com/DapperLib/Dapper/issues/2227)).

## До и после: замеры

Я запустил одно и то же файловое приложение на 2.1.79 и 2.1.86 с .NET SDK 10.0.302 и `Microsoft.Data.Sqlite` 10.0.12:

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

| Вызов | 2.1.79 | 2.1.86 |
| --- | --- | --- |
| Параметр `DateOnly` | `NotSupportedException`: cannot be used as a parameter value | `2026-09-14` |
| Параметр `TimeOnly` | `NotSupportedException` | `09:30:00` |
| `QuerySingle<DateOnly>` | `0001-01-01`, без ошибки | `2026-09-14` |
| Член `DateOnly` | `DataException`: Error parsing column 1 | `2026-09-14` |

Если вы всё ещё на старой версии, беспокоиться стоит именно о строке со скалярным значением: неверные данные и никакого исключения.

## Что происходит с вашим существующим обработчиком типа

Стандартным обходным путём был `SqlMapper.TypeHandler<DateOnly>`, регистрируемый при запуске. С тем же обработчиком на 2.1.86 мой тест показал, что встроенное сопоставление берёт на себя параметры и члены `DateOnly`: методы обработчика `SetValue` и `Parse` ни разу не вызывались. Только скалярный путь `QuerySingle<DateOnly>` по-прежнему вызывал `Parse`. На 2.1.79 тот же обработчик срабатывал на всех трёх путях.

Если ваш обработчик только преобразовывал между `DateOnly` и `DateTime`, вы ничего не теряете. Если он делал что-то своё, например записывал даты как строки `yyyyMMdd` или целые числа, то теперь на пути параметров он пропускается, и база данных получает то, что провайдер делает с сырым `DateOnly`. Протестируйте перед обновлением.

## Область действия

Поддержка скомпилирована для целевых платформ `net8.0` и `net10.0` в пакете. В сборках `netstandard2.0` и `net461` её нет, а набор тестов явно не ожидает, что она будет работать с устаревшим `System.Data.SqlClient`. Используйте `Microsoft.Data.SqlClient`.

Этот же выпуск также выводит из обращения фиды MyGet и AppVeyor: теперь Dapper публикуется только на nuget.org через Trusted Publishing (OIDC). Если `nuget.config` всё ещё указывает на старый фид MyGet для предварительных сборок, удалите его.
