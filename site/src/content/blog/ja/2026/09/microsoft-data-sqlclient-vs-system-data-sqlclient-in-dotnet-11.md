---
title: ".NET 11 における Microsoft.Data.SqlClient と System.Data.SqlClient の比較"
description: "Microsoft.Data.SqlClient を使ってください。System.Data.SqlClient は非推奨で、触れる型すべてに CS0618 が出ます。さらに .NET 8 が 2026-11-10 にサポート終了を迎えると .NET 向けアセットが削除されます。その日は .NET 11 のリリース日でもあります。実測した機能差、マイグレーションを壊す Encrypt の既定値、そして 7.0 でのパッケージ分割について解説します。"
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "sql-server"
  - "migration"
lang: "ja"
translationOf: "2026/09/microsoft-data-sqlclient-vs-system-data-sqlclient-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

**`Microsoft.Data.SqlClient`** を使ってください。これは僅差の比較ではありませんし、2022 年以降そうであったこともありません。`System.Data.SqlClient` は正式に非推奨で、NuGet パッケージの説明文は文字どおり "DEPRECATED - Use Microsoft.Data.SqlClient." です。すべての公開型に `[Obsolete]` が付いており、Microsoft 自身の段階的な計画によれば、.NET 8 が **2026-11-10** にサポート終了を迎えた時点で .NET 向けアセットは消えます。その日は .NET 11 のリリース日でもあります。残された判断は、`Microsoft.Data.SqlClient` のどのラインを取るか (7.0 か 6.1 LTS か) と、マイグレーションをどう乗り切るかだけです。両パッケージの違いは名前空間だけにとどまらないからです。

以下の内容はすべて macOS 26.6.2 (Apple M4) 上で .NET SDK `10.0.302` を使い、`Microsoft.Data.SqlClient` 7.0.3 と `System.Data.SqlClient` 4.9.1 という執筆時点の最新リリースに対して検証しました。アセットの選択は `net11.0` でも同じです。どちらのパッケージにも `net10.0` や `net11.0` のフォルダーは含まれていないため、.NET 11 のプロジェクトは `runtimes/unix/lib/net9.0/Microsoft.Data.SqlClient.dll` と `runtimes/unix/lib/net8.0/System.Data.SqlClient.dll` を解決します。`net10.0` のプロジェクトが解決するものと完全に同一です。

## 比較マトリクス

| | `Microsoft.Data.SqlClient` 7.0.3 | `System.Data.SqlClient` 4.9.1 |
| --- | --- | --- |
| サポート状況 | STS、開発継続中 (7.0 は 2026-03-17 に GA) | 非推奨、保守のみ |
| 配信元 | [dotnet/SqlClient](https://github.com/dotnet/SqlClient) | [dotnet/maintenance-packages](https://github.com/dotnet/maintenance-packages) |
| 公開型の数 | 7 名前空間に 91 個 | 5 名前空間に 51 個 |
| 公開 API の `[Obsolete]` | なし | あり、すべての型で CS0618 |
| 最上位の .NET アセット | `net9.0` | `net8.0` |
| .NET アセットが削除される時期 | 予定なし | .NET 8 サポート終了、2026-11-10 |
| `Encrypt` の既定値 | 4.0 以降 `true` | `false` |
| `Encrypt` プロパティの型 | `SqlConnectionEncryptOption` | `bool` |
| TDS 8.0 / `Encrypt=Strict` | 5.0 以降で対応 | 非対応 |
| TLS 1.3 | 対応、TDS 8.0 経由 | 非対応 |
| Microsoft Entra ID 認証 | 対応、`Extensions.Azure` 経由 | 非対応 |
| `SqlBatch` | 5.2 以降で対応 | 非対応 |
| セキュア エンクレーブ付き Always Encrypted | 対応 | 非対応 |
| データ分類 / 機密度 | 対応 (6 型) | 非対応 |
| SQL Server 2025 の `json` 型 (`SqlJson`) | 6.0 以降で対応 | 非対応 |
| SQL Server 2025 の `vector` 型 (`SqlVector<T>`) | 6.1 以降で対応 | 非対応 |
| 設定可能な再試行ロジック | 対応 | 非対応 |
| 接続文字列のキーワード数 | 48 | 38 |
| 発行出力、hello-world コンソール | 7.35 MB / 23 アセンブリ | 1.07 MB / 2 アセンブリ |

型とキーワードの数は、両方のアセンブリを `MetadataLoadContext` に読み込んで `GetExportedTypes()` と `SqlConnectionStringBuilder.GetProperties()` を差分比較して得たものであり、リリースノートを読んだ結果ではありません。

## 非推奨のタイムラインがすべてを決める

Microsoft は 2024 年 8 月に[非推奨化の計画](https://github.com/dotnet/announcements/issues/322)を公開しました。これが異例なほど具体的です。バージョン 5.0.0 で .NET 8 と .NET Framework 4.6.2 より古いものをすべて外し、.NET 向けアセットに `[Obsolete]` を付ける。.NET 9 の GA 後は何もしない。.NET 8 のサポート終了後は .NET 向けライブラリアセットを削除し、.NET Framework 4.6.2 以降の利用者のみを残す。そのサポートはパッケージではなく .NET Framework 自体を通じて行われる。告知の表現は明快です。Microsoft はこの時点を過ぎたらパッケージを再び更新する予定はない、としています。

.NET 8 は [2026-11-10 にサポート終了](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/)を迎えます。.NET 11 が RTM に到達するのも同じ日です。したがって「.NET 11 ではどちらの SqlClient を使うか」という問いは自ずと答えが出ます。.NET 11 がサポート対象のランタイムとして存在し始める日、`System.Data.SqlClient` にはサポートされた .NET の居場所がまったくありません。復元は引き続き通ります。`net11.0` のプロジェクトは `net8.0` アセットを問題なく拾って動きます。ただしそれは、接続経路に居座る保守されないコードです。

なお、このパッケージは一点だけ計画から外れました。4.9.1 は 2026-02-12 にリリースされ、当初の計画にはなかった `net8.0` アセットを含んでいます。リポジトリも `dotnet/maintenance-packages` へ移りました。これは保守であって開発ではありません。nuspec の依存関係は依然として `runtime.native.System.Data.SqlClient.sni` の **4.4.0**、2017 年のネイティブ SNI ビルドです。

## コンパイラーがすでに教えてくれること

告知を鵜呑みにする必要はありません。最新のプロジェクトから 4.9.1 を参照して、何でもよいので触ってみてください。

```csharp
// net10.0 (identical on net11.0), System.Data.SqlClient 4.9.1
using System.Data.SqlClient;

var b = new SqlConnectionStringBuilder { DataSource = "localhost", InitialCatalog = "db" };
Console.WriteLine($"Encrypt default: {b.Encrypt}");
```

```text
warning CS0618: 'SqlConnectionStringBuilder' is obsolete:
'Use the Microsoft.Data.SqlClient package instead.'
```

```text
Encrypt default: False
```

同じプログラムを `Microsoft.Data.SqlClient` 7.0.3 に対してビルドすると警告はゼロで、`Encrypt default: True` と出力されます。この 1 行が両パッケージ間で最も影響の大きい動作の違いであり、この記事の残りではそこに相応の紙幅を割きます。

## シムでは埋められない差

`Microsoft.Data.SqlClient` にしか存在しない 10 個の接続文字列キーワードは、単なる利便性ではありません。`SqlConnectionStringBuilder` のプロパティを差分比較すると、正確に次のものが出ます。`Authentication`、`AttestationProtocol`、`ColumnEncryptionSetting`、`CommandTimeout`、`EnclaveAttestationUrl`、`FailoverPartnerSPN`、`HostNameInCertificate`、`IPAddressPreference`、`ServerCertificate`、`ServerSPN`。逆方向の差分は空です。最新ドライバーに欠けているキーワードは `System.Data.SqlClient` にひとつもありません。

これらのキーワードを古いビルダーに渡すと、レガシーアプリを SQL Server 2022 や 2025 に接続しようとしたときに遭遇する失敗パターンがそのまま出ます。

```csharp
// System.Data.SqlClient 4.9.1
new SqlConnectionStringBuilder("Server=localhost;Encrypt=Strict");
// FormatException: String 'Strict' was not recognized as a valid Boolean.

new SqlConnectionStringBuilder("Server=localhost;Authentication=Active Directory Default");
// ArgumentException: Keyword not supported: 'authentication'.

new SqlConnectionStringBuilder("Server=localhost;HostNameInCertificate=sql.contoso.com");
// ArgumentException: Keyword not supported: 'hostnameincertificate'.

new SqlConnectionStringBuilder("Server=localhost;ServerCertificate=/etc/ssl/sql.pem");
// ArgumentException: Keyword not supported: 'servercertificate'.
```

`Encrypt=Strict` は [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8) のクライアント側にあたります。TDS 8.0 は SQL Server 2022 が導入したプロトコル改訂で、TLS ハンドシェイクを TDS の内部ではなくその前に行うようにしたものです。SQL Server クライアントから TLS 1.3 に到達できるのは TDS 8.0 のおかげです。`System.Data.SqlClient` はこれに対応する更新を受けていません。つまり TLS 1.3 は使えず、そこへ至る道もありません。セキュリティチームが TLS 1.3 を要件にしているなら、ドライバーの選択はすでに他の誰かによって決まっています。

Microsoft Entra ID も同様です。`Authentication=Active Directory Default` や `Active Directory Managed Identity` などは、そもそも解析されません。トークンによる方法もありません。`SqlConnection.AccessTokenCallback` は最新ドライバーにしか存在しないメンバーのひとつで、`RetryLogicProvider`、`SspiContextProvider`、`ServerProcessId`、そして `RegisterColumnEncryptionKeyStoreProviders` 一式も同じです。

SQL Server 2025 に接続してネイティブの `json` 列型や `vector` 列を使いたい場合、`Microsoft.Data.SqlTypes.SqlJson` (6.0) と `Microsoft.Data.SqlTypes.SqlVector<T>` (6.1) がサポートされる唯一のクライアント表現です。特に `SqlVector<T>` は、JSON 文字列ではなくコンパクトなバイナリ形式でベクトルを TDS 上に送ります。この列型を検討しているなら、[ネイティブ json 列と nvarchar(max) の比較](/ja/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)が同じ判断のストレージ側を扱っています。

## 古いパッケージを支持する唯一の正直な論拠を実測する

`System.Data.SqlClient` は小さいです。残された利点はそれだけですが、それは本物です。hello-world のコンソールアプリを (`dotnet publish -c Release -r osx-arm64 --self-contained false` で) それぞれのドライバーに対して発行しました。

| パッケージ | 発行出力 | アセンブリ数 | 推移的パッケージ数 |
| --- | --- | --- | --- |
| `System.Data.SqlClient` 4.9.1 | 1.07 MB | 2 | 4 |
| `Microsoft.Data.SqlClient` 7.0.3 | 7.35 MB | 23 | 22 |
| `Microsoft.Data.SqlClient` 6.1.7 | 17.3 MB | 29 | 29 |

この 6.1.7 の行こそ、すでに最新ドライバーを使っていた人にとっても 7.0 のリリースが重要である理由です。2 つの発行フォルダーを比較すると、7.0.3 では `Azure.Core`、`Azure.Identity`、`Microsoft.Identity.Client`、`Microsoft.Identity.Client.Broker`、`Microsoft.Identity.Client.Extensions.Msal`、`Microsoft.Identity.Client.NativeInterop`、`System.ClientModel`、`System.Memory.Data`、`Microsoft.Bcl.AsyncInterfaces`、そして 6.1.7 の出力全体で最大のファイルである **7.5 MB** の `msalruntime_arm64.dylib` が消えます。どこにも認証しないコンソールアプリに入っていた、MSAL ブローカーのネイティブバイナリです。バージョン 7.0 はこれらをすべてオプションの `Microsoft.Data.SqlClient.Extensions.Azure` パッケージへ移し、その結果、出力は 10.2 MB 小さくなりました。

とはいえ `Microsoft.Data.SqlClient` は、非推奨パッケージのおよそ 7 倍のデプロイサイズです。トリミングしたコンテナーイメージや Native AOT バイナリなど、それが本当に効いてくる状況なら、復元グラフに追加される 22 個のパッケージと併せて天秤にかけてください。ただし推奨は変わりません。6 MB のアセンブリは、サポートされない TLS スタックと引き換えにする価値はありません。しかしこれは古いパッケージが勝つ唯一の数字であり、そうでないふりをするのは不誠実でしょう。

## `Encrypt` の反転がマイグレーションを壊す

`System.Data.SqlClient` から `Microsoft.Data.SqlClient` へのマイグレーションが失敗するとき、その大半はここで失敗します。古い既定値は `Encrypt=false` です。最新の既定値は 4.0 以降 `Encrypt=true` です。10 年動き続けてきた接続文字列が、自己署名証明書を使う開発用 SQL Server に対して証明書の検証で落ち始めます。

反射的な対処が `TrustServerCertificate=true` ですが、管理された開発マシン以外ではこれは誤りです。暗号化を認証なしのトンネルに変えてしまいます。`Microsoft.Data.SqlClient` にはより良い手段が 2 つあり、どちらも古いドライバーにはないキーワードです。

```csharp
// Microsoft.Data.SqlClient 7.0.3
// The server's cert is issued to sql-prod.internal but you connect by IP or alias.
var cs = "Server=10.0.4.12,1433;Database=orders;"
       + "Encrypt=Strict;"
       + "HostNameInCertificate=sql-prod.internal;"
       + "Authentication=Active Directory Default";
```

`HostNameInCertificate` は、検証を無効化せずに名前の不一致を解決します。`ServerCertificate` は、自己署名またはプライベート CA のサーバー向けに特定の PEM または CER ファイルを指定します。これも検証を無効化しません。この 2 つがあれば、コードベースにある実際の `TrustServerCertificate=true` はほぼすべて、検証を維持したまま置き換えられます。

同じ領域にもうひとつ罠があります。`SqlConnectionStringBuilder.Encrypt` は 5.0 で型が `bool` から `SqlConnectionEncryptOption` に変わりました。`builder.Encrypt = true` のような代入は暗黙の変換のおかげで引き続きコンパイルできるため、ソース互換に見えます。しかしこれは**バイナリ**の破壊的変更です。新しいドライバーに対して再コンパイルしなかったアセンブリは、実行時に `MissingMethodException` をスローします。共有のデータアクセスライブラリを配布しているなら、下のドライバーだけ差し替えるのではなく、再ビルドして再発行してください。同じ種類のミスは、古い 6.x のコピーが復元で勝ったときに [Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' エラー](/ja/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/)を引き起こします。

## マイグレーション中に刺さる、さらに 4 つのこと

**Entra 認証には 2 つ目のパッケージが必要になりました。** 7.0 では、入れ忘れたときに謎の症状ではなく明確なメッセージが出ます。これは実質的な改善です。

```text
System.ArgumentException: Cannot find an authentication provider for 'ActiveDirectoryDefault'.
Install the 'Microsoft.Data.SqlClient.Extensions.Azure' NuGet package to use
Active Directory (Entra ID) authentication methods.
```

`Microsoft.Data.SqlClient.Extensions.Azure` を、コアドライバーと同じバージョンに固定して追加してください。7.0.2 以降、コアドライバーと関連パッケージはバージョン番号が揃えられているので、どちらも `7.0.3` です。

**一部の型は名前空間が変わりますが、すべてではありません。** `SqlDataRecord` と `SqlMetaData` は `Microsoft.SqlServer.Server` から `Microsoft.Data.SqlClient.Server` へ移ります。`SqlFileStream` は `System.Data.SqlTypes` から `Microsoft.Data.SqlTypes` へ、`SqlNotificationRequest` は `System.Data.Sql` から `Microsoft.Data.Sql` へ、`OperationAbortedException` は `System.Data` から `Microsoft.Data` へ移ります。一方で SQL CLR の属性はそのままです。`SqlFunctionAttribute`、`SqlUserDefinedTypeAttribute`、`IBinarySerialize` などは、今日は `System.Data.SqlClient` のアセンブリ内にあり、最新ドライバーでは別の `Microsoft.SqlServer.Server` パッケージにあります。推移的依存の一覧にそのパッケージが現れるのはこのためです。`System.Data` に対する無差別な置換はやめてください。`CommandType`、`DbType`、`IsolationLevel`、`DataTable`、そして `System.Data.Common` のすべての型は、まったく同じ場所にとどまります。

**日付と時刻のパラメーターの挙動が違います。** `DbType.Time` に `DateTime` 値を渡すのは古いドライバーでは受け付けられましたが、最新のものは `TimeSpan` を求めます。`DbType.Date` に `DateTime` 値を渡すと、時刻部分は送信されず切り捨てられます。日付列のまわりに `AddWithValue` の呼び出しがあるなら、そこに静かな挙動変化が潜んでいます。重要な箇所では `SqlDbType`、長さ、精度、スケールを明示的に指定してください。

**globalization-invariant モードはサポートされません。** 起動時間とサイズを削るためにコンテナーで `InvariantGlobalization=true` を設定している場合、その構成での `Microsoft.Data.SqlClient` はサポート対象外です。これは上で述べたトリミング作業をしているチームにこそ刺さります。

そしてマイグレーション完了を宣言する前に、`dotnet list package --include-transitive` を実行してください。直接参照を外しても、古い ORM や SQL CLR のヘルパーが引き込んでいる参照は消えません。1 つのグラフに 2 つの SqlClient パッケージがあってもビルドは通り、そして一方の `SqlConnection` がもう一方を期待する API に渡された瞬間に失敗します。名前は同一でも、型は別物だからです。

## Microsoft.Data.SqlClient のどのラインを取るか

| ライン | リリース日 | サポート | サポート終了 |
| --- | --- | --- | --- |
| 7.0 (`7.0.3`) | 2026-03-17 | STS | 次のリリースで決定 |
| 6.1 (`6.1.7`) | 2025-08-14 | **LTS** | 2028-08-14 |

.NET 11 の新規サービスなら **7.0.3** を取ってください。10 MB 軽いパッケージ、`SspiContextProvider` によるプラグイン可能な SSPI、Azure SQL Hyperscale 向けの拡張ルーティング、そして .NET Framework 上での `SqlClientDiagnosticListener` の同等機能が手に入ります。書面上の期限付きサポート確約が必要な場合や、マイグレーションの途中で今すぐ `Extensions.Azure` の分割を受け入れられない場合は **6.1.7** を取ってください。どちらも SQL Server 2017 から 2025、Azure SQL、Fabric をサポートします。6.0 以下はすべてサポート外で、2026-01-20 に終了した 5.1 LTS ラインも含まれます。

推奨は冒頭で述べたとおりです。移行してください。コンパイラーはすでに警告を出しており、パッケージの説明はすでに非推奨と言っており、古いパッケージが対象とするランタイムは .NET 11 のリリース日にサポート終了を迎えます。作業内容は、パッケージの差し替え、名前空間の一巡、構成にあるすべての `Encrypt` と `TrustServerCertificate` の見直し、そして `SqlConnectionStringBuilder` に触れるすべてのアセンブリの再ビルドです。通常のサービスなら 1 日を見込んでください。保守されないドライバーに TLS 1.3 の要件が降ってくる日より、はるかにましな 1 日です。

## 関連記事

- [Fix: EF Core 更新後の Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'](/ja/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/)
- [2026 年に .NET Framework 4.8 から .NET 11 へ移行する](/ja/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [SQL Server 互換性レベル 150 と 160: EF Core 11 のクエリで何が変わるか](/ja/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/)
- [EF Core 11 で SQL Server に JSON を格納する: ネイティブ json 列と nvarchar(max) の比較](/ja/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)
- [Fix: EF Core の MigrateAsync と CanConnectAsync が 'Login failed for user' で 60 秒間再試行し続ける](/ja/2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core/)

## 参考資料

- [Announcement: System.Data.SqlClient package is now deprecated](https://github.com/dotnet/announcements/issues/322)、dotnet/announcements の issue 322。段階的な非推奨化計画の全文。
- [Migrate from System.Data.SqlClient to Microsoft.Data.SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/migrate-system-data-sql-client-to-microsoft-data-sql-client)、MS Learn、2026-09-16 更新。
- [Microsoft.Data.SqlClient namespace and compatibility](https://learn.microsoft.com/en-us/sql/connect/ado-net/introduction-microsoft-data-sqlclient-namespace)、MS Learn。
- [SqlClient driver support lifecycle](https://learn.microsoft.com/en-us/sql/connect/ado-net/sqlclient-driver-support-lifecycle)、MS Learn。7.0 と 6.1 のサポート表について。
- [Microsoft.Data.SqlClient 7.0.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md)、dotnet/SqlClient。
- [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8)、MS Learn。`Encrypt=Strict` と TLS 1.3 の関係について。
- [.NET 8 and .NET 9 will reach end of support on November 10, 2026](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/)、.NET Blog。
- [NuGet の System.Data.SqlClient](https://www.nuget.org/packages/System.Data.SqlClient)、バージョン 4.9.1、2026-02-12 公開。
