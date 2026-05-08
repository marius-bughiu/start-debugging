---
title: "Fix: The JSON value could not be converted to System.DateTime"
description: "System.Text.Json は DateTime に ISO 8601 文字列のみ受け付けます。2026-05-08T14:00:00Z を送るか、JsonConverter を登録してフォーマットをパースしてください。空文字や Unix タイムスタンプも例外を投げます。"
pubDate: 2026-05-08
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "ja"
translationOf: "2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime"
translatedBy: "claude"
translationDate: 2026-05-08
---

修正方法: `System.Text.Json` は、`"2026-05-08T14:00:00Z"` や `"2026-05-08T14:00:00+02:00"` のような拡張 ISO 8601 形式の JSON 文字列からのみ `DateTime` をデシリアライズします。プロデューサーが `"05/08/2026"`、空文字 `""`、Unix タイムスタンプの数値、Newtonsoft の `"/Date(1746715200000)/"` を送ってきた場合、デシリアライザーは例外を投げます。ワイヤーフォーマットを ISO 8601 に変えるか、実際に受け取るフォーマットをパースできる `JsonConverter<DateTime>` を登録してください。

```text
System.Text.Json.JsonException: The JSON value could not be converted to System.DateTime. Path: $.startedAt | LineNumber: 0 | BytePositionInLine: 27.
   at System.Text.Json.ThrowHelper.ReThrowWithPath(ReadStack& state, JsonReaderException ex)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
 ---> System.FormatException: The JSON value is not in a supported DateTime format.
```

このガイドは .NET 11 preview 4 と `System.Text.Json` 11.0.0-preview.4 を対象に書かれています。受理されるフォーマットと例外は、`System.Text.Json` が .NET Core 3.0 で出荷されて以来変わっていません。内部の `FormatException` のテキストは .NET 8 のあたりで整えられました。`Path` セグメントは問題のあるプロパティの JSON パスで、最初に読むべき情報です。何も計装することなく、コンバーターがどのフィールドで詰まったかを教えてくれます。

## なぜ System.Text.Json はこれほど厳しいのか

`System.Text.Json` は意図的に、`DateTime` と `DateTimeOffset` について [ISO 8601-1:2019 Extended プロファイル](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support) のみを実装しています。フォーマットはリテラルの `T` をセパレーターとする `YYYY-MM-DDTHH:mm:ss[.fffffff][Z|+hh:mm]` でなければなりません。小文字の `t`、スペースのセパレーター、米国式 `MM/dd/yyyy`、2 桁年、秒の欠落、時刻のみまたは日付のみの値はすべて拒否されます。プロパティが null 許容な `DateTime?` でない限り JSON の `null` トークンも、空文字 `""` も同様です。

これは意図的な設計です。Newtonsoft.Json の寛容なマルチフォーマットパーサーは、あるロケールのプロデューサーが `01/05/2026` を送り、別のロケールのコンシューマーがそれを暗黙のうちに誤った日付としてパースする、という現実のバグを生んでいました。`System.Text.Json` は DateTime のパースを JSON における数値と同じように扱います。1 つの正規形、推測なし、です。

ですからデシリアライザーが例外を投げるのは正しい挙動です。仕事は、ワイヤーを準拠させるか、ワイヤーフォーマットを `DateTime` にちょうど 1 回マッピングするコンバーターを登録するか、です。

## 最小再現

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

record Event(DateTime StartedAt);

var bad = """{ "startedAt": "05/08/2026" }""";
var ev = JsonSerializer.Deserialize<Event>(bad); // throws
```

プロデューサーは米国ロケールのスラッシュ日付を送り、`System.Text.Json` はそのフォーマットを知りません。同じエラーは次のいずれのペイロードでも発生します。

```json
{ "startedAt": "" }
{ "startedAt": "2026-05-08" }
{ "startedAt": 1746715200 }
{ "startedAt": "/Date(1746715200000)/" }
{ "startedAt": "2026-05-08 14:00:00" }
{ "startedAt": "Friday, May 8, 2026" }
```

それぞれ理由は異なります。空文字は日付としてパースできません。裸の日付 `"2026-05-08"` には時刻コンポーネントがなく、ISO 8601 Extended は `T` と時刻を要求します。Unix タイムスタンプの数値は `DateTime` にまったくバインドできません。`/Date(...)` 構文は Newtonsoft の歴史的な遺物です。スペース区切りのフォーマットは ISO 8601 Basic であって Extended ではありません。英語の長い形式はマシン用フォーマットではありません。

## 修正の詳細

### 1. プロデューサーに ISO 8601 を送らせる

正しい答えは発生源で直すことです。`T` と UTC の `Z` (または明示的なオフセット) を持つ ISO 8601 Extended は、あらゆる現代スタックでラウンドトリップします。JavaScript の `Date.prototype.toISOString()`、Python の `datetime.isoformat()`、Postgres の `to_char(... 'YYYY-MM-DD"T"HH24:MI:SSOF')`、Java の `Instant.toString()`、.NET の `DateTime.UtcNow.ToString("o")` はすべてこれを出力します。

```csharp
// .NET 11, C# 14
var iso = DateTime.UtcNow.ToString("o"); // 2026-05-08T14:00:00.0000000Z
```

プロデューサーをコントロールできるなら、これは 1 行の作業です。`"u"` (`T` ではなくスペース区切りを使う) は避け、オフセットなしで `DateTime.Now` を文字列化することも避けてください。後者は `Unspecified` 種別の値を作り、曖昧にラウンドトリップします。

### 2. 非 ISO フォーマット用に JsonConverter を登録する

プロデューサーを変更できない (サードパーティ API、レガシーペイロード) 場合は、コンバーターを書きます。コンバーターのパターンはソースフォーマットに関係なく同じで、変わるのはパース呼び出しだけです。

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class UsSlashDateConverter : JsonConverter<DateTime>
{
    private const string Format = "MM/dd/yyyy";

    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var text = reader.GetString();
        return DateTime.ParseExact(
            text!, Format, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToUniversalTime().ToString(Format, CultureInfo.InvariantCulture));
}
```

オプションに 1 度登録し、すべての呼び出し箇所で `new` しないでください。

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    Converters = { new UsSlashDateConverter() }
};
var ev = JsonSerializer.Deserialize<Event>(bad, options);
```

常に `CultureInfo.InvariantCulture` を渡し、`ParseExact` で正確なフォーマットを固定してください。`Parse` と `TryParse` はカレントカルチャーに依存し、ISO 8601 が取り除こうとしたまさにその曖昧さを再導入します。コンバーターの足場の詳細については、[カスタム JsonConverter の手順](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) が、コンバーターが高スループットなパイプラインに置かれるときに重要になるホットパスのテクニック (`Utf8JsonReader.ValueSpan`、span パース) をカバーしています。

### 3. Unix タイムスタンプを数値対応リーダーで変換する

ワイヤーが数値 (`"startedAt": 1746715200`) を送ってくる場合、トークンが `Number` であって `String` ではないので、`reader.GetString()` は例外を投げます。`TokenType` で分岐してください。

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class UnixSecondsConverter : JsonConverter<DateTime>
{
    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        return reader.TokenType switch
        {
            JsonTokenType.Number => DateTimeOffset.FromUnixTimeSeconds(reader.GetInt64()).UtcDateTime,
            JsonTokenType.String when long.TryParse(reader.GetString(), out var s)
                => DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime,
            JsonTokenType.String
                => DateTime.Parse(reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
            _ => throw new JsonException($"Unexpected token {reader.TokenType} for DateTime.")
        };
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteNumberValue(new DateTimeOffset(value, TimeSpan.Zero).ToUnixTimeSeconds());
}
```

これは、文字列と数値のペイロードを混在させる古い REST API (Twitter、Stripe、Slack のレガシーフィールド) のために書くコンバーターです。`DateTimeOffset.FromUnixTimeSeconds` が正しいヘルパーです。`Ticks` 値を作るために 10,000 を掛けないでください。そのパスは秒未満の精度を落とし、エポックの差を無視します。

### 4. 空文字を null として扱う

API のよくある癖が、「日付なし」に対して `""` を送ることです。デシリアライザーは空文字を `DateTime` にも `DateTime?` にもバインドできません。プロパティを null 許容にし、空入力で `null` を返すコンバーターを追加します。

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class NullableEmptyDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        var text = reader.GetString();
        if (string.IsNullOrEmpty(text)) return null;
        return DateTime.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime? value,
        JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue();
        else writer.WriteStringValue(value.Value.ToString("o", CultureInfo.InvariantCulture));
    }
}
```

1 つのフィールドだけが問題を起こすなら、プロパティに `[JsonConverter(typeof(NullableEmptyDateTimeConverter))]` を付けてプロパティ単位で適用します。上記のグローバル登録はグラフ内のすべての `DateTime?` についてデフォルトコンバーターを置き換えます。プロパティ属性の方が範囲が狭く安全です。

### 5. 時刻がないなら DateOnly を使う

ワイヤーが本当に `"2026-05-08"` (時刻のないカレンダー日付) なら、コンシューマー側の型は `DateTime` ではなく `DateOnly` であるべきです。`System.Text.Json` 8.0+ にはビルトインのサポートがあり、ISO 8601 の日付フォーマットを直接受け付けます。

```csharp
// .NET 11, C# 14
record Event(DateOnly StartedOn);

var json = """{ "startedOn": "2026-05-08" }""";
var ev = JsonSerializer.Deserialize<Event>(json); // works, no converter needed
```

`DateOnly` が .NET 6 で追加されたのは、まさに「時刻なしの日付」が DateTime 関連で最も多いモデリングバグだったためです。ドメインが本当にカレンダー日 (誕生日、納品日、祝日) であれば、型を切り替えれば JSON パースの問題は霧散します。

## これを引き起こすよくある形

### プロパティが struct の DateTime だが、値が欠落しうる

null 非許容の `DateTime` は「不在」を保持できません。プロデューサーが `null` または `""` を送り、デシリアライザーが投げます。プロパティを `DateTime?` にしてください。スキーマをコントロールできない場合、`[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` は出力時のラウンドトリップを整えますが、読み取りパスは依然として null 許容が必要です。

### 設定された Newtonsoft の日付フォーマットが契約に漏れている

Newtonsoft.Json から移行している場合、古いコードにはおそらく `IsoDateFormatString = "MM/dd/yyyy"` や `JsonSerializerSettings` 上の `DateTimeFormat` 設定があったはずです。Newtonsoft はこれを受理しましたが、`System.Text.Json` はその設定をまったく尊重しません。リポジトリで `DateFormatHandling`、`DateTimeFormat`、`IsoDateFormatString` を検索し、プロデューサーを直すか上記のコンバーターを書くかしてください。vstest チームは [Newtonsoft.Json の推移的依存を削除](/ja/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) しました。これは .NET 11 preview 4 で同様の契約厳格化のためです。

### MVC のモデルバインディングが内部例外を飲み込む

ASP.NET Core では、リクエストボディの不正な日付は `400 Bad Request` を `{"errors":{"$.startedAt":["The JSON value could not be converted to System.DateTime..."]}}` とともに生成します。内部例外の `Path: $.startedAt` が `errors` ディクショナリに入ります。"One or more validation errors occurred" だけしか見えない場合は、レスポンスボディを確認してください。問題のパスはそこにあります。

### ソースジェネレーターがコンバーター登録を隠す

`[JsonSerializable]` と `JsonSerializerContext` で `System.Text.Json` のソース生成にオプトインすると、コンバーターはランタイムの `JsonSerializerOptions` だけでなく同じコンテキストにも登録しなければなりません。ジェネレーターは各ルート型の `TypeInfo` をコンパイル時に出力しますが、コンテキストへの結線を忘れたコンバーターはランタイムで不可視になります。[interceptors とソース生成のポスト](/ja/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) は、トリミングと AOT を生き延びる登録形を解説しています。

### タイムゾーンが値ではなくプロパティ名に埋め込まれている

`{"startedAtUtc": "2026-05-08T14:00:00"}` のようなスキーマ (`Z` がないがプロパティ名で UTC を主張) は `DateTimeKind.Unspecified` にパースされます。例外は投げませんが、ラウンドトリップは間違っています。`ToUniversalTime` はこれをローカルとして扱います。プロデューサーを直して `Z` を出力するか、`DateTimeOffset` を使ってオフセットを明示してください。さらに良いのは、`Kind == Utc` をアサートし、それ以外では投げるコンバーターを使って値を `DateTime` としてモデル化することです。strict コンバーターのパターンはドリフトを早期に捕捉します。

## このエラーに見えるが違うバリアント

### "The JSON value could not be converted to System.DateTimeOffset"

ルート原因のファミリーは同じで、ドメインが少し違います。`DateTimeOffset` は明示的なオフセット (`Z` または `+hh:mm`) を要求し、裸の `DateTime` なら受理する `Unspecified` 形の文字列を拒否します。修正は同じ形です。オフセットを送るか、コンバーターを書きます。ドメインに `DateTimeOffset` があるなら `DateTime` を経由してラウンドトリップさせないでください。オフセット情報はデータです。

### "Cannot get the value of a token type 'Number' as a String"

別の例外、別のスタックです。コンバーターまたはデフォルトリーダーが JSON の `Number` トークンに対して `GetString()` を呼んだことを意味します。修正は読み取り前に `reader.TokenType` で分岐することです。上記のバリアント 3 のコンバーターが正規形です。

### "A possible object cycle was detected"

参照サイクルであって日付パースではありません。オプションに `ReferenceHandler = ReferenceHandler.IgnoreCycles` (またはグラフ全体のラウンドトリップなら `Preserve`) を設定します。トレードオフは [サイクル処理ガイド](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) で解説されています (同じコンバーターのポストの落とし穴セクションでサイクルオプションをカバーしています)。

### "The JSON value could not be converted to System.Guid"

例外クラスは同じ (`JsonException`)、メッセージ形も同じ、ターゲット型が違います。原因は似ています。Guid 文字列が `System.Text.Json` の受理する 4 つのフォーマット (`D`、`N`、`B`、`P`) のいずれにもなっていません。修正は再び、プロデューサーを `D` (ハイフン付き形式) を送るように直すか、`Guid.ParseExact` を呼ぶコンバーターを書くかです。

### "The JSON value could not be converted to System.Enum"

同じファミリーです。修正はオプションに `JsonStringEnumConverter` (組み込み) を登録することです。コンバーターは数値形式と文字列形式の両方を受け付け、大文字小文字感度を設定できます。.NET 8 以降は `[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]` で enum 単位も可能で、アセンブリ内のすべての enum をリフレクションしないため、トリミング下では好ましいです。

## 関連

上記の修正が依拠するコンバーターの足場については、[カスタム JsonConverter の手順](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) がホットパス向けのバイト span パースのテクニックをカバーしています。[PascalCase メンバー単位命名のポスト](/ja/2026/04/system-text-json-11-pascalcase-per-member-naming/) は、関連する「プロパティ名が違う」400 エラーを解消する `[JsonPropertyName]` と命名ポリシーの脱出ハッチを示します。EF Core 11 で DateTime を JSON カラムとして永続化する場合、[SQL Server 2025 JSON contains の手順](/ja/2026/04/efcore-11-json-contains-sql-server-2025/) はデータベースが同じ ISO 8601 文字列をどうラウンドトリップさせるかを説明します。より大きなグラフ的含意を伴う「型違い」診断の並行ケースとしては、[Newtonsoft から System.Text.Json への移行の道筋](/ja/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) が .NET チーム自身による正規のケーススタディです。

## 出典

- [DateTime and DateTimeOffset support in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support), Microsoft Learn.
- [How to write custom converters](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to), Microsoft Learn.
- [`DateTimeStyles` enumeration](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.datetimestyles), Microsoft Learn.
- [`DateTimeOffset.FromUnixTimeSeconds`](https://learn.microsoft.com/en-us/dotnet/api/system.datetimeoffset.fromunixtimeseconds), Microsoft Learn.
- [System.Text.Json source repository](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Text.Json), dotnet/runtime on GitHub.
- [`DateOnly` and `TimeOnly` types](https://learn.microsoft.com/en-us/dotnet/api/system.dateonly), Microsoft Learn.
