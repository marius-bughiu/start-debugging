---
title: "SQLite-net No parameterless constructor defined for this object bei ExecuteQuery"
description: "So beheben Sie den Fehler 'no parameterless constructor defined' in SQLite-net, wenn Sie ExecuteQuery mit primitiven Typen wie string oder int verwenden."
pubDate: 2023-09-01
updatedDate: 2023-11-05
tags:
  - "sqlite"
lang: "de"
translationOf: "2023/09/sqllitenet-no-parameterless-constructor-defined-for-this-object-on-executequery"
translatedBy: "claude"
translationDate: 2026-05-01
---
Vermutlich versuchen Sie, eine einzelne Spalte aus einer Tabelle Ihrer Datenbank mit etwas wie `SELECT <column_name> FROM <table_name>` über `ExecuteQuery<string>` oder `ExecuteQuery<int>` abzurufen.

Das Problem dabei: `ExecuteQuery<string>` erwartet einen Typ mit einem parameterlosen Konstruktor, und `string` erfüllt diese Anforderung nicht.

Es gibt zwei mögliche Lösungen:

## Lösung 1: Verwenden Sie den Tabellentyp

Lassen Sie die SQL-Query unverändert und wählen Sie weiterhin nur eine Spalte aus. Übergeben Sie aber beim Aufruf von `ExecuteQuery` den zur Tabelle gehörenden Typ. Um die Performance müssen Sie sich keine Sorgen machen: Nur die ausgewählte Spalte wird abgerufen und in Ihre Objekte gefüllt; alle anderen Properties bleiben leer.

Anschließend verwenden Sie LINQ, um Ihren `string`-Wert herauszuziehen.

```cs
cmd.ExecuteQuery<MyTableType>().Select(t => t.MyColumnName).ToArray();
```

## Lösung 2: Verwenden Sie ein DTO speziell für Ihre Query

Wenn Sie den Tabellentyp nicht verwenden möchten, können Sie für diese Query ein eigenes DTO definieren und stattdessen verwenden. Denken Sie daran: Es benötigt einen öffentlichen, parameterlosen Konstruktor.

```cs
public class MyQueryDto
{
    public string MyColumnName { get; set; }
}
```

Geben Sie es dann an die `ExecuteQuery`-Methode weiter und ziehen Sie optional anschließend die Spalte als String-Array heraus.

```cs
cmd.ExecuteQuery<MyQueryDto>().Select(t => t.MyColumnName).ToArray();
```
