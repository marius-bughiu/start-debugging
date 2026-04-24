---
title: "Dapper のデフォルト nvarchar パラメータが SQL Server のインデックスを静かに殺すしくみ"
description: "Dapper を通じて送られる C# 文字列はデフォルトで nvarchar(4000) になり、SQL Server に暗黙変換と完全なインデックススキャンを強制します。DbType.AnsiString でこれを修正する方法を紹介します。"
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "sql-server"
  - "dapper"
  - "performance"
lang: "ja"
translationOf: "2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes"
translatedBy: "claude"
translationDate: 2026-04-24
---

ミリ秒で終わるはずのクエリが突然這うように遅くなります。実行プランは seek ではなく index scan を示し、CPU はすべての行の変換で残業しています。犯人は? `varchar` カラムに対して Dapper を通じて渡された C# `string` パラメータです。

この問題は .NET コミュニティでまた周回しており、それには理由があります: 微妙で、よくあり、クエリを [最大 268 倍遅く](https://consultwithgriff.com/dapper-nvarchar-implicit-conversion-performance-trap) できます。

## なぜ実行プランに nvarchar(4000) が現れるのか

C# の文字列を anonymous object 経由で Dapper に渡すと、Dapper はデフォルトで `nvarchar(4000)` にマップします:

```csharp
const string sql = "SELECT * FROM Products WHERE ProductCode = @productCode";
var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, new { productCode });
```

`ProductCode` が `varchar(50)` カラムなら、SQL Server は型不一致を見ます。Unicode の `nvarchar` は `varchar` より優先順位が高いので、engine は比較前にカラム値を `nvarchar` に昇格させるために、インデックスのすべての行で `CONVERT_IMPLICIT` を適用します。

つまり index seek なし、です。SQL Server はインデックス全体を行ごとにスキャンし、行くうちに変換していきます。

## 問題の発見

決定的な兆候は実行プランにあります。`CONVERT_IMPLICIT` を言及する index scan オペレーターの警告を探してください。こうも確認できます:

```sql
SELECT * FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE st.text LIKE '%ProductCode%'
ORDER BY qs.total_worker_time DESC;
```

シンプルなルックアップクエリで `total_worker_time` が高いのは赤旗です。

## DbType.AnsiString で修正

修正はストレートです: デフォルトの `DbType.String` ではなく `DbType.AnsiString` を使うよう Dapper に指示します:

```csharp
var parameters = new DynamicParameters();
parameters.Add("productCode", productCode, DbType.AnsiString, size: 50);

var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, parameters);
```

正しいカラムサイズと一緒に `DbType.AnsiString` を指定することで、生成されるパラメータがカラム型と正確に一致します。SQL Server は今やそのために設計された index seek を使えます。

## いつ最も重要になるか

小さなテーブルでは問題が完全に隠れることがあります。データが増えるにつれてパフォーマンスの崖が現れます: 100,000 行のテーブルは 176 倍の遅延を示す可能性があり、100 万行のテーブルではさらに悪化します。`varchar` カラム (legacy データベースや Unicode を必要としないシステムでよくあります) で Dapper を使っているなら、パラメータ型を監査してください。

Dapper の `Query` と `Execute` メソッドに渡される anonymous object を project-wide に grep するのが良い出発点です。`varchar` カラムをターゲットにするすべての `string` パラメータは `DbType.AnsiString` の候補です。
