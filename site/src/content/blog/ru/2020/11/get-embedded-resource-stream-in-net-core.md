---
title: "Получение Stream встроенного ресурса в .NET Core"
description: "Узнайте, как получить поток встроенного ресурса в .NET Core, разобравшись, как формируется имя ресурса, и используя GetManifestResourceStream."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2020/11/get-embedded-resource-stream-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Чтобы получить встроенный ресурс в .NET Core, сначала нужно понять, из чего состоит имя ресурса. Оно состоит из 3 элементов, соединённых точками (`.`):

-   корневой namespace
-   расширенный (файловый) namespace
-   имя файла

Возьмём конкретный пример. У нас есть проект (сборка) с корневым namespace `MyApp.Core`. Внутри проекта есть папка и подпапка `Assets` > `Images`. А в ней лежит встроенный ресурс с именем `logo.png`. В этом случае:

-   корневой namespace: `MyApp.Core`
-   расширенный namespace: `Assets.Images`
-   имя файла: `logo.png`

Соедините их через `.` и получите: `MyApp.Core.Assets.Images.logo.png`.

Когда вы знаете идентификатор ресурса, вам нужна лишь ссылка на сборку, в которой находится сам ресурс. Её легко получить от любого класса, объявленного в этой сборке - допустим, у нас есть класс `MyClass`:

```cs
typeof(MyClass).Assembly.GetManifestResourceStream("MyApp.Core.Assets.Images.logo.png")
```

## Получение списка всех встроенных ресурсов сборки

Если ресурс не находится, это обычно происходит по одной из следующих причин:

-   неверно указан идентификатор
-   файл не помечен как Embedded Resource
-   вы ищете не в той сборке

Чтобы упростить отладку, можно вывести список всех встроенных ресурсов сборки и плясать от него. Для этого:

```cs
typeof(MyClass).Assembly.GetManifestResourceNames()
```

Это вернёт обычный `string[]`, который удобно использовать в `Immediate Window` для отладки.
