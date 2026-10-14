---
title: ".NET 11 RC 2 の CborReader は CBOR ペイロードをチャンク単位で解析できます"
description: "System.Formats.Cbor 11.0.0-rc.2 は CborReader に isFinalBlock、NeedsMoreData、SlideData を追加し、ドキュメント全体をバッファリングせずにストリームから直接 CBOR をデコードできるようにします。SDK 11.0.100-rc.2 で検証済みです。"
pubDate: 2026-10-14
tags:
  - "dotnet-11"
  - "csharp"
  - "cbor"
  - "dotnet"
lang: "ja"
translationOf: "2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally"
translatedBy: "claude"
translationDate: 2026-10-14
---

[.NET 11 Release Candidate 2](https://github.com/dotnet/core/discussions/10644) が 2026年10月13日にリリースされました。go-live ライセンス付きの 2 つ目、かつ最後の RC です。ライブラリのリリースノートは、ソケット、パイプ、大きなファイルから CBOR をデコードする人にとって重要な変更から始まります。`System.Formats.Cbor` の `CborReader` が、ドキュメント全体を連続した 1 つの `ReadOnlyMemory<byte>` として要求する代わりに、チャンクに分割されて届くペイロードを読み取れるようになりました ([dotnet/runtime#134374](https://github.com/dotnet/runtime/pull/134374)、[#133602](https://github.com/dotnet/runtime/pull/133602) のバックポート)。

## 従来のリーダーが全体のバッファを必要としていた理由

これまでの `CborReader` は、完全なドキュメントを自分が所有していることを前提にしていました。WebAuthn のアテステーション、COSE メッセージ、CTAP2 のレスポンスをネットワーク経由で受け取る場合、まず全体をバイト配列に読み込む必要がありました。数百バイトなら問題ありません。しかし数メガバイトの CBOR ログや、長時間続く CBOR レコードのストリームでは、ペイロードと同じサイズの割り当てが発生し、最後のバイトが届くまで処理を開始できません。

## 追加された 3 つの要素

RC 2 のパッケージ (`System.Formats.Cbor` 11.0.0-rc.2.26504.105) では次が追加されます。

- コンストラクターのオーバーロード `CborReader(ReadOnlyMemory<byte> data, CborReaderOptions? options, bool isFinalBlock)`。
- 次の項目が途中で切れている場合に `PeekState()` が返す新しい `CborReaderState.NeedsMoreData` の値。
- リーダーに次のバッファを渡す `SlideData(ReadOnlyMemory<byte> data, bool isFinalBlock)`。加えて `Reset(data, isFinalBlock)` と、例外をスローしない `TrySkipValue` / `TrySkipToParent`。

厳しい条件が 1 つあります。インクリメンタルモードは `CborConformanceMode.Lax` でのみ動作します。`Strict` で `isFinalBlock: false` を渡すと `ArgumentException: Reading CBOR data incrementally is only supported in the 'Lax' conformance mode.` がスローされます。

## Stream から読み取る

公式のサンプルは "buffer management omitted" で終わっています。自分で用意する必要があるのは、`SlideData` がバッファを置き換えるため、リーダーがまだ消費していないバイトを次のバッファに持ち越す部分です。その数は `BytesRemaining` で分かります。

```csharp
static async Task<int> ReadAllStringsAsync(Stream stream)
{
    var options = new CborReaderOptions { ConformanceMode = CborConformanceMode.Lax };
    byte[] chunk = new byte[4096];
    ReadOnlyMemory<byte> buffer = ReadOnlyMemory<byte>.Empty;
    var reader = new CborReader(buffer, options, isFinalBlock: false);
    int count = 0;

    while (true)
    {
        switch (reader.PeekState())
        {
            case CborReaderState.NeedsMoreData:
                int read = await stream.ReadAsync(chunk);
                // Keep the bytes the reader has not consumed yet, then append the new chunk.
                ReadOnlyMemory<byte> unread = buffer[^reader.BytesRemaining..];
                byte[] next = new byte[unread.Length + read];
                unread.CopyTo(next);
                chunk.AsSpan(0, read).CopyTo(next.AsSpan(unread.Length));
                buffer = next;
                reader.SlideData(buffer, isFinalBlock: read == 0);
                break;
            case CborReaderState.StartArray: reader.ReadStartArray(); break;
            case CborReaderState.EndArray: reader.ReadEndArray(); break;
            case CborReaderState.TextString: reader.ReadTextString(); count++; break;
            case CborReaderState.Finished: return count;
            default: reader.SkipValue(); break;
        }
    }
}
```

SDK 11.0.100-rc.2.26504.105 上で、1,000 個のテキスト文字列を含む 10,003 バイトの配列に対してこれを実行しました。結果は 1,000 件すべてを返しました。チャンクを 7 バイトまで小さくしても全項目をデコードでき、その間の `SlideData` 呼び出しは 1,428 回でした。空のバッファから始めても動作します。最初の `PeekState()` が単に `NeedsMoreData` を報告するだけです。本番環境では、チャンクごとに割り当てるのではなく、`next` を `ArrayPool<byte>` からレンタルするとよいでしょう。

## 読み取る前に必ず Peek する

再開可能かどうかのシグナルは `PeekState()` からしか得られません。途中で切れた項目に対して直接 `ReadTextString()` を呼ぶと、穏やかな "need more data" ではなく `CborContentException: Declared definite length of CBOR data item exceeds available buffer size` が発生します。インクリメンタルモードでは、すべての読み取りの前に `PeekState()` を門番として使ってください。項目を読み飛ばすだけなら `TrySkipValue` を使います。

RC 2 には go-live ライセンスがあるため、今日から本番環境で使えます。GA は 11 月の予定です。リリースを追いかけている方は、前回取り上げたライブラリの変更として [RC 1 のプロセスシグナル](/ja/2026/09/dotnet-11-rc-1-process-signal-exit-status/)もご覧ください。
