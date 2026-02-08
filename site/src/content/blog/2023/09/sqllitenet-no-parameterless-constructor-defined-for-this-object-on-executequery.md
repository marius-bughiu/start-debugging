---
title: "SqlLiteNet – no parameterless constructor defined for this object on ExecuteQuery"
description: "You are likely trying to retrieve a single column from a table in your database by passing something similar with SELECT <column_name> FROM <table_name> to an ExecuteQuery<string> or ExecuteQuery<int>. The problem with that is that ExecuteQuery<string> expects a type having a parameterless constructor – for which string does not qualify. There are two possible solutions:…"
pubDate: 2023-09-01
updatedDate: 2023-11-05
tags:
  - "sqlite"
---
You are likely trying to retrieve a single column from a table in your database by passing something similar with `SELECT <column_name> FROM <table_name>` to an `ExecuteQuery<string>` or `ExecuteQuery<int>`.

The problem with that is that `ExecuteQuery<string>` expects a type having a parameterless constructor – for which `string` does not qualify.

There are two possible solutions:

## Solution 1: Use the table type

Leave your SQL query as it is – selecting a single column, but when calling `ExecuteQuery` make sure to provide the type associated with your table. Don’t worry too much about the query performance in this case as only that specific column will be retrieved and filled in your objects; the rest of the properties will be ignored.

Afterwards, you can use LINQ to select your `string`.

```cs
cmd.ExecuteQuery<MyTableType>().Select(t => t.MyColumnName).ToArray();
```

## Solution 2: Use a DTO specific to your query

If you don’t like using the table-associated type, you can always define a custom DTO for this particular query and use that instead. Remember, it needs to have a public parameterless constructor.

```cs
public class MyQueryDto
{
    public string MyColumnName { get; set; }
}
```

And then pass it along to the `ExecuteQuery` method and optionally select your column into a string array after the fact.

```cs
cmd.ExecuteQuery<MyQueryDto>().Select(t => t.MyColumnName).ToArray();
```
