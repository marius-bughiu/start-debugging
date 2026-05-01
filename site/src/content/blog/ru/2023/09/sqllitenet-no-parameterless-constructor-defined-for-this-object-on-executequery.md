---
title: "SQLite-net No parameterless constructor defined for this object в ExecuteQuery"
description: "Как исправить ошибку 'no parameterless constructor defined' в SQLite-net при использовании ExecuteQuery с примитивными типами вроде string или int."
pubDate: 2023-09-01
updatedDate: 2023-11-05
tags:
  - "sqlite"
lang: "ru"
translationOf: "2023/09/sqllitenet-no-parameterless-constructor-defined-for-this-object-on-executequery"
translatedBy: "claude"
translationDate: 2026-05-01
---
Скорее всего, вы пытаетесь получить один столбец из таблицы базы данных, передавая что-то вроде `SELECT <column_name> FROM <table_name>` в `ExecuteQuery<string>` или `ExecuteQuery<int>`.

Проблема в том, что `ExecuteQuery<string>` ожидает тип с конструктором без параметров, а `string` под это требование не подходит.

Есть два возможных решения:

## Решение 1: используйте тип таблицы

Оставьте SQL-запрос как есть — выбираете один столбец, но при вызове `ExecuteQuery` обязательно укажите тип, ассоциированный с вашей таблицей. О производительности сильно беспокоиться не стоит: будет извлечён и заполнен в объектах только этот конкретный столбец; остальные свойства будут проигнорированы.

После этого можно с помощью LINQ выбрать ваш `string`.

```cs
cmd.ExecuteQuery<MyTableType>().Select(t => t.MyColumnName).ToArray();
```

## Решение 2: используйте отдельный DTO под запрос

Если не хочется использовать тип таблицы, всегда можно определить отдельное DTO под этот запрос и использовать его. Помните: у него должен быть публичный конструктор без параметров.

```cs
public class MyQueryDto
{
    public string MyColumnName { get; set; }
}
```

Затем передайте его в метод `ExecuteQuery` и при необходимости выберите столбец в массив строк уже после.

```cs
cmd.ExecuteQuery<MyQueryDto>().Select(t => t.MyColumnName).ToArray();
```
