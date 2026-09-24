---
title: "Microsoft が NuGet の作成者署名証明書をローテーション: NU3034 が発生する前に trustedSigners を修正する"
description: "2026-09-23 以降、NuGet 上の Microsoft パッケージは新しい証明書 (SHA-256 9A1B131B...) で作成者署名されます。nuget.config の trustedSigners で Microsoft を固定している場合、復元は NU3034 で失敗します。正しい dotnet nuget trust コマンドを含む修正方法を解説します。"
pubDate: 2026-09-24
tags:
  - "nuget"
  - "dotnet"
  - "security"
  - "supply-chain"
lang: "ja"
translationOf: "2026/09/microsoft-nuget-author-signing-certificate-rotation-nu3034"
translatedBy: "claude"
translationDate: 2026-09-24
---

2026-09-23、.NET チームは、Microsoft が nuget.org 上のパッケージの作成者署名に使う証明書を切り替えることを[発表しました](https://devblogs.microsoft.com/dotnet/microsoft-author-signing-certificate-update-2026/)。ほとんどのプロジェクトは気付きもしないでしょう。しかし、`signatureValidationMode="require"` と Microsoft を指定した `<trustedSigners>` リストで NuGet を運用している場合や、CI で `dotnet nuget verify --certificate-fingerprint` を実行している場合は、新しい証明書で署名された最初のパッケージが `NU3034` で失敗し、ビルドが壊れます。

## フィンガープリント

新しい証明書の SHA-256 フィンガープリントは `9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630` です。置き換えられる証明書は `566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353` です。さらに古い 2 つのフィンガープリント `3F9001EA...` と `AA12DA22...` も、何年も前に署名されたパッケージのために引き続き有効です。

どれも削除しないでください。nuget.org にすでにあるパッケージは元の署名を保持しているため、信頼リストは最新のものだけでなく、Microsoft がこれまでに使ったすべての証明書を受け入れる必要があります。

## ロールアウトは段階的に進む

`Microsoft.Playwright` 1.63.0 (2026-09-23 20:23 UTC 公開) と `Microsoft.Identity.Web` 4.15.0 をダウンロードし、SDK 10.0.302 で `dotnet nuget verify --all -v normal` を実行しました。どちらもまだ古い証明書で署名されています。

```text
Signature type: Author
  Subject Name: CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US
  SHA256 hash: 566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353
  Valid from: 27/07/2023 03:00:00 to 18/10/2026 02:59:59
```

古い証明書は 2026-10-18 に期限切れになります。Microsoft の各チームはそれぞれのスケジュールで公開するため、今後数週間でパッケージが順次新しい証明書に切り替わると考えてください。10 月 18 日以降、古い証明書では新たに何も署名できません。今日動いているビルドが、来週の火曜日に失敗する可能性は十分にあります。

## 発表記事の trust コマンドは動かない

ブログ記事では `dotnet nuget trust author Microsoft <fingerprint> --algorithm SHA256` が提案されています。SDK 10.0.302 ではこれは `Unrecognized command or argument '--algorithm'` で失敗します。`trust author` はフィンガープリントではなく、署名済みパッケージへのパスを受け取るためです。生のフィンガープリントを追加するには [`trust certificate`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-trust) を使います。

```bash
dotnet nuget trust certificate Microsoft 9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630 --algorithm SHA256 --configfile nuget.config
```

`Microsoft` の author エントリがすでに存在する場合、このコマンドはそこにフィンガープリントを追加します ("Successfully updated the trusted signer 'Microsoft'")。結果の構成には 4 つすべてが並んでいるはずです。

```xml
<trustedSigners>
  <author name="Microsoft">
    <certificate fingerprint="3F9001EA83C560D712C24CF213C3D312CB3BFF51EE89435D3430BD06B5D0EECE" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="AA12DA22A49BCE7D5C1AE64CC1F3D892F150DA76140F210ABD2CBFFCA2C18A27" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
  </author>
</trustedSigners>
```

## CI の検証ステップ

`dotnet nuget verify` は `--certificate-fingerprint` を複数回受け付けます。4 つすべてを渡してください。フィンガープリントが 1 つだけだと、別の証明書で署名されたパッケージに当たった時点でチェックが失敗します。たとえば、Playwright 1.63.0 を新しいフィンガープリントだけで検証すると、次のように出力されます。

```text
error: NU3034: The package signature did not match any of the allowed certificate fingerprints.
```

nuget.org を社内フィードにミラーし、取り込み時に署名をチェックしている組織は、そちらにも同じ変更が必要です。`trustedSigners` モデルの残りの部分は、[NU3034 リファレンス](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu3034)と[署名済みパッケージのガイド](https://learn.microsoft.com/en-us/nuget/consume-packages/installing-signed-packages)で説明されています。復元が新しい証明書を使うパッケージに出会う前に、今のうちに新しいフィンガープリントを追加しておくほうが、10 月半ばに赤くなったビルドをデバッグするよりもずっと簡単です。
