---
title: "モダンな .NET で削除された BinaryFormatter からの移行"
description: "BinaryFormatter の実装は .NET 9 で削除され、.NET 10 と .NET 11 でも PlatformNotSupportedException をスローし続けます。代替シリアライザーの選び方、NrbfDecoder による永続化済み NRBF ブロブの読み取り、WinForms・WPF・ResX で壊れるものを解説します。"
pubDate: 2026-09-02
updatedDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "binaryformatter"
  - "serialization"
  - "system-text-json"
  - "dotnet-10"
  - "dotnet-11"
  - "security"
  - "dotnet"
lang: "ja"
translationOf: "2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet"
translatedBy: "claude"
translationDate: 2026-09-02
---

自分の型を自分のストレージにシリアライズしているだけのサービスなら、`BinaryFormatter` からの脱却に 1 日から 3 日かかります。NRBF ペイロードが自分の管理外の境界 (キュー、共有データベースの列、独自のリリース周期で配布されるデスクトップクライアント) を越えてしまったコードベースでは数週間かかります。難しいのはシリアライザーの差し替えではなく、古いペイロードを抜き切ることだからです。組み込みの実装は .NET 9 Preview 6 で削除され、そのまま削除された状態が続いています。.NET 9、.NET 10、.NET 11 preview のいずれでも、`BinaryFormatter.Serialize` と `BinaryFormatter.Deserialize` はプロジェクトの種類にかかわらず [`PlatformNotSupportedException`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal) をスローし、従来の MSBuild プロパティ `EnableUnsafeBinaryFormatterSerialization` だけでは復活しません。本ガイドは .NET 10.0.11 (GA) を対象に書かれており、.NET 11 SDK (preview 7、2026 年 8 月)、`System.Formats.Nrbf` 10.0.11、`System.Runtime.Serialization.Formatters` 10.0.11 についても補足します。

## これが任意ではない理由

- **もうフラグは残っていません。** .NET 8 では無効化スイッチが既定でオンになり、`<EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>` はまだ機能していました。.NET 9 以降はこのプロパティ単体では無意味です。実装コードが共有フレームワークに存在しません。
- **互換性パッケージは明示的にサポート対象外です。** `System.Runtime.Serialization.Formatters` は脆弱性込みの動作する実装を提供します。締め切りをしのぐための一時しのぎであって、行き先ではありません。
- **リスクの正体はバグではなくフォーマットです。** NRBF はどの型をインスタンス化するかをペイロード自身に埋め込みます。これは [CWE-502 "Deserialization of Untrusted Data"](https://cwe.mitre.org/data/definitions/502.html) そのものです。ペイロードにコンストラクターを選ばせることが仕事であるフォーマットは、いくらパッチを当てても直りません。
- **古いブロブはデシリアライズせずに読めます。** 削除と同時に .NET 9 で出荷された `NrbfDecoder` は、カスタム型を 1 つも読み込まずに NRBF をレコードへデコードします。一斉切り替えではなく段階的な移行を可能にしているのはこれです。

## 何が壊れるか

| 領域 | 変更点 | 深刻度 |
| --- | --- | --- |
| `BinaryFormatter.Serialize` / `Deserialize` | すべてのプロジェクト種別で、呼び出すたびに `PlatformNotSupportedException` をスロー | 高 |
| `EnableUnsafeBinaryFormatterSerialization` | 単体では不十分になり、互換性パッケージも必要 | 高 |
| 永続化済みの NRBF ブロブ | フレームワーク内にこれをデシリアライズするものはもうありません | 高 |
| `SoapFormatter`、`NetDataContractSerializer` | 削除済み、または[危険なシリアライザー](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-security-guide)に分類。移行先にはなりません | 高 |
| WinForms/WPF のクリップボードとドラッグアンドドロップ | 組み込み型の一覧だけがラウンドトリップします。`DataFormats.Serializable` とカスタム形式はそれ以外で失敗 | 高 |
| WinForms デザイナー / ResX | カスタム型のデザイン時シリアライズには `TypeConverter` が必要 | 中 |
| `Exception(SerializationInfo, StreamingContext)` | `SYSLIB0051` として非推奨。旧来の例外シリアライズは不要な荷物 | 中 |
| MSBuild の `MSB3825` | バイナリ形式のリソースに関する警告。`GenerateResourceWarnOnBinaryFormatterUse` で抑制 | 低 |
| `SettingsPropertyValue.PropertyValue` | 型が `object` のため、カスタム型を保持する `System.Configuration` のユーザー設定は API を壊さずに移行できません | 高 |

## 事前チェックリスト

- .NET SDK 10.0.100 以降がインストール済みであること (`dotnet --list-sdks`)。
- 棚卸し: `grep -rn "BinaryFormatter\|IFormatter\|SoapFormatter\|NetDataContractSerializer" --include=*.cs .` に加えて NuGet 依存関係のスキャン。驚かされるのは推移的な呼び出し元だからです。
- 何かに手を付ける**前に**、すべてのシリアライズ境界にラウンドトリップテストを用意すること。シリアライズのバグは静かです。3 リリース後に null のフィールドとして現れます。
- 本番ストレージから取り出した実際の永続化済みペイロードのサンプル。合成ペイロードではバージョンのずれを検証できません。
- 各ペイロードについて、生成側と消費側の両方を自分が管理しているかどうかの判断を文書化すること。管理していないなら、必要なのは単純な差し替えではなく手順 4 のデュアルリード経路です。

## 移行手順

1. **呼び出し箇所ではなく、ペイロード境界を棚卸ししてください。** `BinaryFormatter` の利用箇所を、バイト列の行き先で分類します。メモリ内のみ (ディープクローンのヘルパー)、プロセスローカルのキャッシュ、永続ストレージ (データベースの列、ブロブ、ディスク上のファイル)、プロセス間 (クリップボード、キュー、remoting 風の RPC) の 4 つです。メモリ内とプロセスローカルの利用は 1 コミットで差し替えられます。永続とプロセス間はフォーマットの移行期間が必要です。各境界に到達する型の閉じた集合を記録してください。

   検証: 上記の `grep` のヒットがすべて 4 分類のいずれか 1 つに割り当てられており、永続境界ごとに担当者名とシリアライズ対象型の一覧が記載されていること。

2. **境界ごとに代替シリアライザーを選んでください。** そのまま置き換えられるものは存在せず、すべてで同じものを選ぶ必要もありません。[公式の比較](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer)を整理するとこうなります。ペイロードがテキストでよく、型に属性を付けられるなら `System.Text.Json` (一覧の中で AOT の一級サポートとソース生成の両方を備える唯一の選択肢)。型をまったく変更できないなら `DataContractSerializer` (`[Serializable]` と `ISerializable` を尊重する唯一の推奨シリアライザー)。ペイロードをコンパクトなバイナリのまま保つ必要があるなら [MessagePack for C#](https://github.com/MessagePack-CSharp/MessagePack-CSharp) か [protobuf-net](https://github.com/protobuf-net/protobuf-net) です。

   検証: 手順 1 の各境界の横にシリアライザーが 1 つと、1 行の理由が書かれていること。理由が「既定だったから」なら、やり直してください。

3. **まずメモリ内とプロセスローカルの利用を差し替えてください。** これは無償の成果であり、難しい手順の対象面積を減らします。`[Serializable]` な型を `System.Text.Json` に移すと、以前は暗黙だったものすべてに明示的なオプトインが必要になります。フィールドは指定しない限りシリアライズされず、private メンバーには独自のコントラクトが必要で、`[Serializable]` 自体には何の意味もありません。

   ```csharp
   // .NET 10.0.11, C# 14
   using System.Text.Json;
   using System.Text.Json.Serialization;

   [JsonSourceGenerationOptions(IncludeFields = true)]
   [JsonSerializable(typeof(CartSnapshot))]
   internal partial class CartContext : JsonSerializerContext;

   public sealed class CartSnapshot
   {
       public int Version;                 // a field, so IncludeFields is required
       public string? CouponCode { get; set; }
       public List<int> LineItemIds { get; set; } = [];
   }

   byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, CartContext.Default.CartSnapshot);
   CartSnapshot? back = JsonSerializer.Deserialize(bytes, CartContext.Default.CartSnapshot);
   ```

   検証: `dotnet test` がグリーンであり、ラウンドトリップのアサーションが、思い出せたものだけでなく public **と** private のすべてのメンバーを比較していること。

4. **永続境界ごとにデュアルリード経路を追加してください。** これがリリースを可能にする手順です。`NrbfDecoder.StartsWithPayloadHeader` は、いま読んだバイト列が旧来の NRBF かどうかを教えてくれます。そうであればデコードし、新しいシリアライザーで再シリアライズして書き戻します。読み取りが遅延的に既存データを移行し、書き込みは初日から新形式のみになります。

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   internal static CartSnapshot Load(string path)
   {
       byte[] raw = File.ReadAllBytes(path);

       if (!NrbfDecoder.StartsWithPayloadHeader(raw))
       {
           return JsonSerializer.Deserialize(raw, CartContext.Default.CartSnapshot)!;
       }

       CartSnapshot upgraded = ReadLegacy(raw);
       File.WriteAllBytes(path, JsonSerializer.SerializeToUtf8Bytes(upgraded, CartContext.Default.CartSnapshot));
       return upgraded;
   }
   ```

   検証: 本番の実際の NRBF サンプルを一時ファイルに書き出し、`Load` を呼んで値を確認し、その後 2 回目の `Load` が旧来の分岐を通らないことを確認するテスト。

5. **`ReadLegacy` を `NrbfDecoder` で、1 つの型ずつ実装してください。** `NrbfDecoder` はデコードするだけです。あなたの型をインスタンス化せず、アセンブリを読み込まず、再帰もしません。構築するのはあなたであり、だからこそ信頼できない入力に対して安全です。`ClassRecord` は型付きアクセサーでメンバーを名前から公開し、`TypeNameMatches` はアセンブリの同一性を無視して型名を比較するので、型の転送やアセンブリのバージョン変更で壊れることはありません。

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   private static CartSnapshot ReadLegacy(byte[] raw)
   {
       using MemoryStream stream = new(raw);
       ClassRecord root = NrbfDecoder.DecodeClassRecord(stream);

       if (!root.TypeNameMatches(typeof(CartSnapshot)))
       {
           throw new InvalidDataException($"Unexpected payload type '{root.TypeName.AssemblyQualifiedName}'.");
       }

       SZArrayRecord<int> ids = (SZArrayRecord<int>)root.GetArrayRecord(nameof(CartSnapshot.LineItemIds))!;
       if (ids.Length > 10_000)
       {
           throw new InvalidDataException("Line item array exceeds the sane limit.");
       }

       return new CartSnapshot
       {
           Version = root.HasMember(nameof(CartSnapshot.Version)) ? root.GetInt32(nameof(CartSnapshot.Version)) : 1,
           CouponCode = root.GetString(nameof(CartSnapshot.CouponCode)),
           LineItemIds = [.. ids.GetArray()],
       };
   }
   ```

   `HasMember` はバージョニングのための逃げ道です。ペイロードが書かれた時点から今日までの間に追加または改名されたフィールドは、例外ではなく `false` になります。`GetArray` の前の長さチェックは任意ではありません。NRBF では悪意あるペイロードが 20 億個の null を安価に約束できてしまうからです。

   検証: 保存された実際のペイロードに対する旧型ごとのデコードテストと、サイズ超過または型違いのペイロードがメモリを確保せずに `InvalidDataException` をスローすることを確認するテスト。

6. **どうしても型を変更できない場合は、手順 3 から 5 の代わりに `DataContractSerializer` を使ってください。** これは `[Serializable]` と `ISerializable` のプログラミングモデルを尊重する唯一の推奨選択肢で、型には手を入れずに済みます。難点は、既知の型を private なものも含めて事前に指定する必要があることと、いくつかの一般的な型 (特に `DateTimeOffset`) が既定の許可リストに入っていないことです。`PreserveObjectReferences` は、`BinaryFormatter` が無償で提供していたオブジェクトの同一性と循環の扱いを取り戻します。

   ```csharp
   // .NET 10.0.11
   using System.Runtime.Serialization;

   DataContractSerializer serializer = new(
       typeof(CartSnapshot),
       new DataContractSerializerSettings
       {
           KnownTypes = [typeof(PercentageCoupon), typeof(FixedAmountCoupon), typeof(DateTimeOffset)],
           PreserveObjectReferences = true,
       });
   ```

   名前が近そうだからといって `NetDataContractSerializer` に手を出さないでください。`BinaryFormatter` と同じようにペイロードへ型情報を埋め込み、危険なシリアライザーとして挙げられています。

   検証: 意図的な循環を含むグラフを含む、既知の型の全閉包に対するラウンドトリップテストが `PreserveObjectReferences = true` で通ること。

7. **WinForms と WPF は別扱いにしてください。** .NET 9 以降、どちらのフレームワークもクリップボード、ドラッグアンドドロップ、デザイン時リソースに NRBF のサブセットを内部利用しますが、対象は組み込みの一覧に限られます。プリミティブ、`string`、`decimal`、`TimeSpan`、`DateTime`、`nint`、`nuint`、`PointF`、`RectangleF`、加えて WinForms では `Bitmap` と `ImageListStreamer`、そしてそれらの配列とリストです。それ以外は `BinaryFormatter` にフォールバックして失敗します。クリップボードとドラッグアンドドロップで推奨される対処は、自分で `string` か `byte[]` (通常は JSON) をクリップボードに載せ、受け取り側でパースすることです。カスタム型のデザイナー/ResX シリアライズについては、`TypeConverter` を登録して、デザイナーが `BinaryFormatter` に落ちる代わりにそれを使うようにします。

   検証: カスタム形式ごとに、アプリの実行中インスタンス 2 つの間で手動のコピー＆ペーストとドラッグアンドドロップを行い、さらにデザイナーのラウンドトリップ (フォームを開く、保存する、開き直す) を `MSB3825` も実行時例外もなしで通すこと。

8. **互換性パッケージの判断はその後です。** サードパーティの依存関係が内部で `BinaryFormatter` を呼んでいて、その修正を待てない場合は、`System.Runtime.Serialization.Formatters` を**アプリケーション**プロジェクトにのみインストールしてください。このパッケージは `BinaryFormatter` の型 ID を変えないので、グラフ内のライブラリは再ビルドなしで動作する実装を拾います。

   ```xml
   <!-- .NET 10.0.11. Unsupported, and a temporary measure. -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>
   </PropertyGroup>

   <ItemGroup>
     <PackageReference Include="System.Runtime.Serialization.Formatters" Version="10.0.11" />
   </ItemGroup>
   ```

   ResX については関門がもう 1 つあります。AppContext スイッチ `System.Resources.Extensions.UseBinaryFormatter` も `true` に設定してください。

   検証: パッケージ参照がちょうど 1 つのプロジェクトファイルにのみ存在し、そうせざるを得なかった依存関係を名指しした日付入りの追跡 issue があること。

## 移行を検証する

- `grep -rn "BinaryFormatter" --include=*.cs src/` が、旧形式のデコード経路とそのテスト以外で何も返さない。
- `dotnet build -warnaserror` がクリーンで、`SYSLIB0011` も `MSB3825` も出ない。
- `dotnet test -c Release` がグリーンで、本番ペイロードの実サンプルに対する旧型ごとのデコードテストを少なくとも 1 つ含む。
- ステージングの実行が本番の既存データを読む。旧来の分岐を通ったペイロード数をログに出し、移行期間を通じてゼロに近づくことを確認する。
- ログに first-chance の `PlatformNotSupportedException` が出ていない。
- アプリが WinForms か WPF なら、クリップボードとドラッグアンドドロップを 1 プロセス内だけでなく 2 プロセス間で確認済みである。

## ロールバック

コードの変更は元に戻せますが、データの変更は戻せません。手順 4 がブロブを新形式で書き直した時点で古いバイト列は失われるため、NRBF しか理解しないビルドへロールバックしても読めません。計画に織り込むべき帰結が 2 つあります。ロールバック期間中は旧形式のバイト列を保持すること (更新後のペイロードは同じ場所に上書きせず新しい列やキーに書き、期間が終わってから古い方を消す)。そして移行カウンターがゼロになってからも、`NrbfDecoder` による旧形式の読み取り経路を最低 1 リリースはコードに残すこと。互換性パッケージをつなぎとしてデプロイする場合、ロールバック自体は簡単ですが、デプロイされている間ずっとセキュリティ上の露出は現実のものです。追跡 issue には日付を入れてください。

## 始める前に知っておきたい落とし穴

**`[Serializable]` は `System.Text.Json` にとって何の意味もありません。** private フィールドを持ち public コンストラクターがない型は、`BinaryFormatter` ではラウンドトリップできていても、JSON では黙って `{}` を出力します。失敗は例外ではなく空の出力です。だからこそ手順 3 のラウンドトリップテストは private な状態まで比較する必要があります。

**オブジェクトの同一性は失われます。** `BinaryFormatter` は参照を保持し、循環も扱えました。`System.Text.Json` には `ReferenceHandler.Preserve` が、`DataContractSerializer` には `PreserveObjectReferences = true` が必要で、どちらも省くと、共有されていた子オブジェクトはラウンドトリップ後に黙って 2 つのオブジェクトになります。デシリアライズ後の参照等価性に依存していた古いコードの前提は、もう成り立ちません。

**`NrbfDecoder` はデコーダーであって、`BinaryFormatter` のエミュレーターではありません。** その挙動は意図的に `BinaryFormatter` と一致していないので、デコードに成功したことを `BinaryFormatter` の呼び出しが安全だった証拠として使うことはできません。また、.NET Framework が NRBF ペイロードに書き込めたものの .NET が一度も読まなかった、開始インデックスがゼロ以外の配列もサポートしません。

**まったく移行できないライブラリもあります。** `SettingsPropertyValue.PropertyValue` は `object` 型なので、`System.Configuration` の設定ファイルには文字どおり何でも入り得ました。デコード対象となる型の閉じた集合が存在せず、API を壊さずに `NrbfDecoder` を使う道はありません。こうした型があるからこそ、手順 1 の棚卸しが最初に来ます。

**例外のシリアライズは別の非推奨です。** `SYSLIB0051` は `Exception(SerializationInfo, StreamingContext)` コンストラクターと、旧来のシリアライズサポートの残りをカバーします。あなたのカスタム例外はおそらくまだそのコンストラクターを持っています。フォーマッター経由で例外をラウンドトリップするものがなくなれば削除して安全ですし、同じ作業のついでに実行するとよい `grep` です。

**バージョンをまたぐ変換は、実装がまだ存在する場所で動かす必要があります。** .NET Framework からも同時に離れるのであれば、`BinaryFormatter` が動くランタイムが手元にあるうちに使い捨てのブロブ変換ツールを書くか、`System.Formats.Nrbf` を使ってください。このパッケージは、デコード側をどこでも動かせるようにするためにこそ .NET Standard 2.0 と .NET Framework もターゲットにしています。

## 関連記事

- BinaryFormatter の手順は [.NET 8 から .NET 11 へのアップグレードチェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)というより大きな飛躍の中に位置し、[.NET Framework 4.8 のコードベースを .NET 11 へ移す](/ja/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)場合はたいてい最も高くつく項目になります。
- 置き換え先が JSON なら、BinaryFormatter が暗黙に扱っていた `[Serializable]` の型階層には[明示的な `JsonDerivedType` の注釈](/ja/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)が必要になり、扱いにくい形は最終的に[カスタム `JsonConverter`](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) に落ち着くのが普通です。
- Newtonsoft の整理と同時に進めるチームは、まず[大規模コードベースでの Newtonsoft から System.Text.Json への移行](/ja/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)を読んでください。2 つの作業は同じファイルに触れます。
- トリミングと AOT のビルドは隣接する壁にぶつかります。[reflection-based serialization has been disabled for this application](/ja/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) と、より広い [Native AOT の PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) の切り分けを参照してください。

## 参照元

- [BinaryFormatter migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/), Microsoft Learn
- [Breaking change: In-box BinaryFormatter implementation removed and always throws](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal), Microsoft Learn
- [Read BinaryFormatter (NRBF) payloads](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/read-nrbf-payloads), Microsoft Learn
- [Choose a serializer](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer), Microsoft Learn
- [WinForms and WPF OLE guidance](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/winforms-wpf-ole-guidance), Microsoft Learn
- [BinaryFormatter removal from .NET 9 is complete](https://github.com/dotnet/announcements/issues/317), dotnet/announcements
- [BinaryFormatter obsoletion plan](https://github.com/dotnet/designs/blob/main/accepted/2020/better-obsoletion/binaryformatter-obsoletion.md), dotnet/designs
- [MS-NRBF: .NET Remoting Binary Format specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nrbf/)
