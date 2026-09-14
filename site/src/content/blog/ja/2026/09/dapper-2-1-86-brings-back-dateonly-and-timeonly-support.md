---
title: "Dapper 2.1.86 で DateOnly と TimeOnly が復活、無効化から 2 年越し"
description: "Dapper 2.1.86 は、パラメーター、メンバー、スカラーに対する DateOnly と TimeOnly の組み込みマッピングを再び有効にし、列のずれと default(T) を黙って返すバグを修正しました。変更点、実際に計測した結果、そしてカスタム型ハンドラーへの影響を解説します。"
pubDate: 2026-09-14
tags:
  - "dapper"
  - "dotnet"
  - "csharp"
lang: "ja"
translationOf: "2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support"
translatedBy: "claude"
translationDate: 2026-09-14
---

Dapper 2.1.86 は 2026-09-12 に NuGet で公開されました。目玉は [リリースノート](https://github.com/DapperLib/Dapper/releases/tag/2.1.86) の 1 行、「DateOnly/TimeOnly のサポートを再有効化し、無効化の原因となった不具合を修正」です。.NET 6 の頃から `SqlMapper.TypeHandler<DateOnly>` を抱えてきた方は、このリリースでそれを削除できます。

## DateOnly サポートが登場し、壊れ、消えるまで

ネイティブの `DateOnly`/`TimeOnly` マッピングは、2024 年 3 月に [#2051](https://github.com/DapperLib/Dapper/pull/2051) で 2.1.37 に初めて入りました。数週間のうちに、2.1.44 のユーザーが [#2072](https://github.com/DapperLib/Dapper/issues/2072) に遭遇しました。`DateOnly` プロパティにマッピングした `datetime` 列が `Error parsing column 1 (FromDate=Ed - String)` で失敗するというもので、エラーが別の列の値を報告するため、1 つずれているように見えました。2024 年 4 月にこの機能はコンパイル対象から外され ([#2080](https://github.com/DapperLib/Dapper/pull/2080))、2.1.66 から 2.1.79 までのすべてのリリースはこの機能なしで出荷されました。

[PR #2228](https://github.com/DapperLib/Dapper/pull/2228) は、症状ではなく根本原因を修正しています。

- 報告される型に変換が必要な列 (`DateOnly` への `datetime` など) は、もう `GetFieldValue<T>` を経由しません。これが #2072 のクラッシュの原因でした。
- メンバー、スカラー、`Parse<T>` の各経路で、`DateOnly`/`TimeOnly` と `DateTime`/`TimeSpan` の間を双方向に変換するようになりました。プロバイダーごとに挙動が異なるため、これは重要です。Npgsql 10 は `date` 列を `DateOnly` としてボックス化しますが、SqlClient と Npgsql 9 は `DateTime` としてボックス化します ([#2226](https://github.com/DapperLib/Dapper/issues/2226))。
- `QuerySingle<DateOnly>` がエラーなしで `default(T)` を返すことはなくなりました ([#2227](https://github.com/DapperLib/Dapper/issues/2227))。

## 修正前と修正後の計測結果

同じファイルベースのアプリを、.NET SDK 10.0.302 と `Microsoft.Data.Sqlite` 10.0.12 の環境で 2.1.79 と 2.1.86 に対して実行しました。

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

| 呼び出し | 2.1.79 | 2.1.86 |
| --- | --- | --- |
| `DateOnly` パラメーター | `NotSupportedException`: パラメーター値として使用できない | `2026-09-14` |
| `TimeOnly` パラメーター | `NotSupportedException` | `09:30:00` |
| `QuerySingle<DateOnly>` | `0001-01-01`、エラーなし | `2026-09-14` |
| `DateOnly` メンバー | `DataException`: 列 1 の解析エラー | `2026-09-14` |

古いバージョンを使い続けている場合に注意すべきなのはスカラーの行です。データは間違っているのに、例外は出ません。

## 既存の型ハンドラーはどうなるか

定番の回避策は、起動時に `SqlMapper.TypeHandler<DateOnly>` を登録することでした。同じハンドラーを 2.1.86 で登録したまま検証したところ、パラメーターと `DateOnly` メンバーでは組み込みマッピングが優先され、ハンドラーの `SetValue` と `Parse` は一度も呼ばれませんでした。`Parse` が呼ばれたのは、スカラーの `QuerySingle<DateOnly>` の経路だけです。2.1.79 では、同じハンドラーが 3 つの経路すべてで実行されていました。

ハンドラーが `DateOnly` と `DateTime` の変換しかしていなかったのなら、失うものはありません。日付を `yyyyMMdd` 形式の文字列や整数として書き込むなど独自の処理をしていた場合、パラメーターの経路ではその処理がスキップされ、データベースにはプロバイダーが生の `DateOnly` をどう扱うかに応じた値が届きます。アップグレード前にテストしてください。

## 対象範囲

このサポートは、パッケージ内の `net8.0` と `net10.0` ターゲット向けにコンパイルされています。`netstandard2.0` と `net461` のビルドには含まれず、テストスイートもレガシーな `System.Data.SqlClient` での動作は明示的に想定していません。`Microsoft.Data.SqlClient` を使ってください。

同じリリースで MyGet と AppVeyor のフィードも廃止されました。Dapper は今後、Trusted Publishing (OIDC) を使って nuget.org にのみ公開します。プレリリースビルドのために `nuget.config` がまだ古い MyGet フィードを指している場合は、削除してください。
