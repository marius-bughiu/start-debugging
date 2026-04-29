---
title: ".NET 10 のポスト量子暗号: ML-KEM、ML-DSA、SLH-DSA"
description: ".NET 10 はポスト量子暗号アルゴリズム ML-KEM、ML-DSA、SLH-DSA をネイティブ サポートし、量子耐性のある未来に向けてアプリケーションを準備します。"
pubDate: 2026-02-08
tags:
  - "dotnet-10"
  - "cryptography"
  - "security"
  - "post-quantum"
lang: "ja"
translationOf: "2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa"
translatedBy: "claude"
translationDate: 2026-04-29
---

量子コンピューターは RSA と楕円曲線暗号を破る可能性をはらんでいます。.NET 10 はこれに対し、NIST が標準化した 3 つのポスト量子アルゴリズム -- ML-KEM (FIPS 203)、ML-DSA (FIPS 204)、SLH-DSA (FIPS 205) -- のネイティブ サポートを追加して応えます。

## なぜポスト量子暗号が今重要なのか

RSA-2048 や ECDSA といった現在の非対称アルゴリズムは、量子コンピューターが効率的に解ける数学的な問題に依拠しています。大規模な量子コンピューターはまだ存在しないものの、「いま収集して後で復号する」攻撃により、今日暗号化された機微なデータが将来露見する可能性があります。NIST は 2024 年 8 月に最初のポスト量子標準を確定し、.NET 10 はそれを実装します。

## 鍵カプセル化のための ML-KEM

ML-KEM (Module-Lattice-Based Key-Encapsulation Mechanism) は ECDH のような鍵交換プロトコルを置き換えます。共有秘密の確立に使います:

```csharp
using System.Security.Cryptography;

// Generate a key pair
using var mlKem = MLKem.Create(MLKemParameterSet.MLKem768);

// Export the public key for the other party
byte[] publicKey = mlKem.ExportPublicKey();

// Other party encapsulates a shared secret
var (ciphertext, sharedSecret) = MLKem.Encapsulate(publicKey);

// Original party decapsulates to get the same shared secret
byte[] decapsulatedSecret = mlKem.Decapsulate(ciphertext);

// sharedSecret and decapsulatedSecret are identical
```

ML-KEM には 3 つのパラメーター セット (MLKem512、MLKem768、MLKem1024) があります。多くのアプリケーションでは MLKem768 がセキュリティとパフォーマンスのバランスを提供します。

## デジタル署名のための ML-DSA

ML-DSA (Module-Lattice-Based Digital Signature Algorithm) は RSA と ECDSA の署名のポスト量子置換です:

```csharp
using System.Security.Cryptography;

byte[] data = "Sign this message"u8.ToArray();

// Generate a key pair
using var mlDsa = MLDsa.Create(MLDsaParameterSet.MLDsa65);

// Sign data
byte[] signature = mlDsa.SignData(data);

// Verify signature
bool isValid = mlDsa.VerifyData(data, signature);
```

ML-DSA のパラメーター セットには MLDsa44、MLDsa65、MLDsa87 があります。MLDsa65 は NIST セキュリティ レベル 3 を提供し、ほとんどのユース ケースに適しています。

## 長期的セキュリティのための SLH-DSA

SLH-DSA (Stateless Hash-Based Digital Signature Algorithm) は ML-DSA に対する保守的な代替です。署名は大きくなりますが、ハッシュ関数の安全性のみに依拠するため、最大の信頼を必要とするシナリオに適します:

```csharp
using System.Security.Cryptography;

byte[] data = "Critical document"u8.ToArray();

using var slhDsa = SLHDsa.Create(SLHDsaParameterSet.SLHDsaSha2_128f);
byte[] signature = slhDsa.SignData(data);
bool isValid = slhDsa.VerifyData(data, signature);
```

「f」(fast) 系は署名速度を優先し、「s」(small) 系は署名サイズを最小化します。

## プラットフォーム要件

.NET 10 のポスト量子暗号には以下が必要です:
- PQC 更新を含む Windows 11 または Windows Server 2025
- OpenSSL 3.5+ を備えた Linux または macOS

サポートされていないプラットフォームでは、`Create` メソッドは `PlatformNotSupportedException` を投げます。

## ハイブリッド アプローチ

移行期間中は、古典的アルゴリズムとポスト量子アルゴリズムを組み合わせることを検討してください。一方が破られても、もう一方が依然として保護を提供します。これは長寿命の証明書やアーカイブされたデータでは特に重要です。

完全な API ドキュメントは [Microsoft Learn のポスト量子暗号](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/overview#cryptography) を参照してください。
