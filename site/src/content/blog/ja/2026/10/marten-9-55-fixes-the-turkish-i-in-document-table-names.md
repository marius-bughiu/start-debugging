---
title: "Marten 9.55 がドキュメントテーブル名のトルコ語 I 問題を修正: アップグレード前にリネームしてください"
description: "Marten 9.55.0 は、ドキュメントのエイリアス、DDL テンプレートのキー、フラットテーブルの upsert 関数名を invariant culture で小文字化するようになりました。tr-TR や az-AZ で動作し、mt_doc_ınvoice のようなテーブルにドキュメントを保存しているアプリは、先にリネームしないとデータが消えたように見えます。"
pubDate: 2026-10-30
tags:
  - "marten"
  - "postgresql"
  - "dotnet"
  - "globalization"
  - "breaking-changes"
lang: "ja"
translationOf: "2026/10/marten-9-55-fixes-the-turkish-i-in-document-table-names"
translatedBy: "claude"
translationDate: 2026-10-30
---

[Marten 9.55.0](https://github.com/JasperFx/marten/releases/tag/V9.55.0) は 2026-10-28 にリリースされました。リリースノートの冒頭には "read before upgrading" セクションがあり、影響を受けるアプリは限られますが、該当する場合の影響は大きいものです。プロセスがトルコ語 (`tr-TR`) またはアゼルバイジャン語 (`az-AZ`) のカルチャーで動作していて、名前に大文字の `I` を含むドキュメント型がある場合、Marten が探すテーブルが変わっています。

## ドットなしの ı はどこから来たのか

Marten は型名からドキュメントのエイリアスを導出し、それがテーブル名になります。9.55 より前は、現在のカルチャーを使う `string.ToLower()` で小文字化していました。トルコ語系のカルチャーでは、`I` の小文字は `i` ではなくドットなしの `ı` (U+0131) です。

```csharp
using System.Globalization;

var tr = CultureInfo.GetCultureInfo("tr-TR");

Console.WriteLine("Invoice".ToLower(tr));        // ınvoice
Console.WriteLine("Invoice".ToLowerInvariant()); // invoice
```

そのため、ドキュメント型 `Invoice` は、トルコ語のサーバーでは `mt_doc_ınvoice` に、それ以外の環境では `mt_doc_invoice` に保存されていました。[PR #5778](https://github.com/JasperFx/marten/pull/5778) で `DocumentMapping` が `ToLowerInvariant()` に切り替わりました。9.55.0 以降は、カルチャーにかかわらず同じ型が `mt_doc_invoice` にマッピングされ、Marten は古いテーブルの隣に空のテーブルを問題なく作成してしまいます。

## 同じリリースで修正された他の 2 つの識別子

[PR #5783](https://github.com/JasperFx/marten/pull/5783) では、現在のカルチャーで小文字化していた別の 2 か所も修正されました。

- **`DdlTemplate` の検索。** Weasel はテンプレートを invariant で小文字化したファイル名でキー付けしており、テンプレートキャッシュは存在しないキーに対して空のエントリを作成します。`tr-TR` では `DdlTemplate("Invoicing")` が `ınvoicing` を検索して空のテンプレートを得て、`GRANT` 文が何も書き出されませんでした。これは純粋なバグ修正で、移行作業は不要です。
- **フラットテーブルプロジェクションの upsert 関数。** `mt_upsert_{table}_{event}` は、以前は `mt_upsert_ınvoices_ınvoiceıssued` のような名前になっていました。アップグレード後、次のマイグレーションで正しい名前の関数が作成され、古い関数は使われないまま残ります。データは移動しないため、手動で削除できます。

## テーブルのリネーム

9.55 のビルドがデータベースに触れる前に実行してください。この DO ブロックは、ドットなしの `ı` を含むすべての Marten ドキュメントテーブルをリネームします。

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE tablename LIKE 'mt\_doc\_%' AND tablename LIKE '%ı%'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I RENAME TO %I',
      r.schemaname, r.tablename, replace(r.tablename, 'ı', 'i'));
  END LOOP;
END $$;
```

リリースノートでは、対応する upsert 関数もリネームするよう求めています。別の方法として、名前に `ı` を含む古い `mt_upsert_`、`mt_insert_`、`mt_update_`、`mt_overwrite_` 関数を削除し、Marten に再生成させることもできます。`SELECT proname FROM pg_proc WHERE proname LIKE '%ı%'` で一覧を確認できます。その後、まずコピーに対して `await store.Storage.ApplyAllConfiguredChangesToDatabaseAsync()` を実行し、生成された差分を確認してください。古い綴りのままのインデックス名や制約名があれば、そこに表示されます。

アプリが `<InvariantGlobalization>true</InvariantGlobalization>` を設定している場合や、英語のカルチャーで動作している場合は、生成される名前は変わらないため、何もする必要はありません。

## その他のユーザー向けのリリースノート

`UseVersionFromMatchingStream` を使うプロジェクションドキュメントの `StoredDocument.Version` は、素の `mt_version` ではなく `<mt_version>:<epoch microseconds>` になりました ([#5773](https://github.com/JasperFx/marten/issues/5773))。そのため、整数としてパースしていたコードは壊れます。また、このリリースでは、新しいストアでデータベース障害の後に HiLo の ID 生成が壊れたままになる問題も修正されています。

PR が注意点として挙げているのは、JasperFx の `ToTableAlias` が依然としてカルチャーに依存することです。これは `mt_events.type` のイベント型名に使われています。変更すると `tr-TR` の既存のイベント行が孤立してしまうため、別途対応が検討されています。トルコ語のサーバーで Marten を動かしている場合は、このフォローアップに注意してください。

```bash
dotnet add package Marten --version 9.55.0
```
