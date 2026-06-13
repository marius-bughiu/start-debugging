---
title: ".NET 11 Preview 5 で X25519 鍵共有が標準搭載されました"
description: ".NET 11 Preview 5 は System.Security.Cryptography に第一級の X25519DiffieHellman 型を追加し、BouncyCastle や NSec なしで Curve25519 の鍵交換ができます。"
pubDate: 2026-06-13
tags:
  - "dotnet-11"
  - "csharp"
  - "cryptography"
  - "security"
lang: "ja"
translationOf: "2026/06/dotnet-11-x25519-key-agreement-preview-5"
translatedBy: "claude"
translationDate: 2026-06-13
---

[.NET 11 Preview 5 の発表](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/)は LINQ と Blazor が中心ですが、安全なトランスポートを構築する人にとって最も重要な一行は、暗号化の項目にある箇条書きです。`System.Security.Cryptography` が X25519 鍵共有を標準で搭載するようになりました。このリリースまで、.NET で Curve25519 上の Diffie-Hellman 交換を行うには BouncyCastle または NSec を取り込む必要がありました。組み込みの `ECDiffieHellman` が Curve25519 を移植可能でクロスプラットフォームな形で公開していなかったためです。

## なぜ Curve25519 は厄介な空白だったのか

X25519 は Curve25519 上の Diffie-Hellman 関数であり、現代の暗号が動くあらゆる場所に存在します。TLS 1.3、SSH、Signal、WireGuard、Noise はいずれも一時鍵の交換にこれを頼っています。高速で、パラメーター検証の厄介な落とし穴がなく、NIST P 曲線の特許やサイドチャネルの負担を回避します。

問題は、.NET の `ECDiffieHellman` が名前付き曲線と SEC の点形式を中心に構築されているのに対し、Curve25519 は異なるエンコーディングを使うことでした。`ECCurve.NamedCurves.nistP256` の親戚を渡して X25519 を得る、ということはできません。そのため、それを必要とする .NET プロジェクトはすべてサードパーティのライブラリに頼り、それに伴うサプライチェーンや AOT トリミングの問題を抱えていました。

## 新しい API サーフェス

Preview 5 は `X25519DiffieHellman`（[API 提案 dotnet/runtime#126206](https://github.com/dotnet/runtime/issues/126206)）を導入します。これはポスト量子の `MLKem` クラスや `MLDsa` クラスと同じファクトリーパターンに従う抽象型です。鍵と共有シークレットはすべて固定の 32 バイトです。

```csharp
using System.Security.Cryptography;

// Each party generates an ephemeral key pair.
using X25519DiffieHellman alice = X25519DiffieHellman.GenerateKey();
using X25519DiffieHellman bob = X25519DiffieHellman.GenerateKey();

// Wire format for the public keys (SubjectPublicKeyInfo).
byte[] alicePub = alice.ExportSubjectPublicKeyInfo();
byte[] bobPub = bob.ExportSubjectPublicKeyInfo();

// Reconstruct the peer's public key and derive the raw shared secret.
using X25519DiffieHellman bobPeer = X25519DiffieHellman.ImportSubjectPublicKeyInfo(bobPub);
byte[] secretA = alice.DeriveRawSecretAgreement(bobPeer);

using X25519DiffieHellman alicePeer = X25519DiffieHellman.ImportSubjectPublicKeyInfo(alicePub);
byte[] secretB = bob.DeriveRawSecretAgreement(alicePeer);

// Both sides computed the same 32 bytes.
Console.WriteLine(CryptographicOperations.FixedTimeEquals(secretA, secretB)); // True
```

メソッド名は意図的です。`DeriveRawSecretAgreement` は生の X25519 出力を返します。この 32 バイトを暗号化鍵として直接使わないでください。TLS がまさにそうしているように、まず KDF に通してください。

```csharp
byte[] key = HKDF.DeriveKey(
    HashAlgorithmName.SHA256,
    ikm: secretA,
    outputLength: 32,
    info: "my-app handshake v1"u8.ToArray());
```

## これが次にどう位置づけられるか

インポートとエクスポートのヘルパーは、期待される一式を網羅します。`ExportPkcs8PrivateKey`、`ImportFromPem`、`ImportEncryptedPkcs8PrivateKey`、そしてホットパス向けの span ベースのオーバーロードです。Windows では実装は CNG が支え、Linux では OpenSSL が支えます。`[SupportedOSPlatform]` の注釈が付いているため、アナライザーが非対応のターゲットについて警告します。

興味深いのは、[.NET 10 のポスト量子プリミティブ](/ja/2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa/)との組み合わせです。X25519 を ML-KEM と組み合わせるハイブリッドハンドシェイクは TLS が向かう方向であり、両方の半分が標準搭載された今、サードパーティの暗号依存を一切使わずに、純粋な .NET でその交換を構築できます。それが Preview 5 の本当の見どころです。
