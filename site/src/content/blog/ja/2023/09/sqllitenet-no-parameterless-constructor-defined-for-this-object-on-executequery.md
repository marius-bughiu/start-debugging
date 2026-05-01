---
title: "SQLite-net ExecuteQuery で No parameterless constructor defined for this object"
description: "string や int のようなプリミティブ型で SQLite-net の ExecuteQuery を使ったときに発生する 'no parameterless constructor defined' エラーの解消方法を解説します。"
pubDate: 2023-09-01
updatedDate: 2023-11-05
tags:
  - "sqlite"
lang: "ja"
translationOf: "2023/09/sqllitenet-no-parameterless-constructor-defined-for-this-object-on-executequery"
translatedBy: "claude"
translationDate: 2026-05-01
---
おそらく、データベースのテーブルから 1 つの列だけを取得しようとして、`SELECT <column_name> FROM <table_name>` のような SQL を `ExecuteQuery<string>` や `ExecuteQuery<int>` に渡しているのではないでしょうか。

問題は、`ExecuteQuery<string>` がパラメーターなしのコンストラクターを持つ型を期待していることで、`string` はその条件を満たさない、という点にあります。

解決策は 2 つあります。

## 解決策 1: テーブル型を使う

SQL クエリは 1 列だけを SELECT する形のまま残しておき、`ExecuteQuery` の呼び出し時にテーブルに対応する型を渡すようにします。この場合、クエリのパフォーマンスはそれほど気にする必要はありません。実際に取得されてオブジェクトに詰められるのは指定した列だけで、それ以外のプロパティは無視されるからです。

その後、LINQ を使って `string` を取り出せます。

```cs
cmd.ExecuteQuery<MyTableType>().Select(t => t.MyColumnName).ToArray();
```

## 解決策 2: そのクエリ専用の DTO を使う

テーブルに紐づく型を使いたくない場合は、このクエリ専用のカスタム DTO を定義して、そちらを使うこともできます。public のパラメーターなしコンストラクターが必要なことを忘れないでください。

```cs
public class MyQueryDto
{
    public string MyColumnName { get; set; }
}
```

それを `ExecuteQuery` メソッドに渡し、必要なら、後から該当の列を string 配列に取り出します。

```cs
cmd.ExecuteQuery<MyQueryDto>().Select(t => t.MyColumnName).ToArray();
```
