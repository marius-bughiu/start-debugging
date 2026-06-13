---
title: "Согласование ключей X25519 встроено в .NET 11 Preview 5"
description: ".NET 11 Preview 5 добавляет полноценный тип X25519DiffieHellman в System.Security.Cryptography, чтобы выполнять обмен ключами Curve25519 без BouncyCastle или NSec."
pubDate: 2026-06-13
tags:
  - "dotnet-11"
  - "csharp"
  - "cryptography"
  - "security"
lang: "ru"
translationOf: "2026/06/dotnet-11-x25519-key-agreement-preview-5"
translatedBy: "claude"
translationDate: 2026-06-13
---

[Анонс .NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) насыщен LINQ и Blazor, но строка, которая важнее всего для тех, кто строит защищённые транспорты, это один пункт в разделе криптографии: `System.Security.Cryptography` теперь включает согласование ключей X25519 из коробки. До этого выпуска выполнить обмен Диффи-Хеллмана на Curve25519 в .NET означало подключать BouncyCastle или NSec, потому что встроенный `ECDiffieHellman` никогда не предоставлял Curve25519 переносимым, кроссплатформенным способом.

## Почему Curve25519 был неудобным пробелом

X25519 это функция Диффи-Хеллмана на Curve25519, и она присутствует везде, где происходит современная криптография: TLS 1.3, SSH, Signal, WireGuard и Noise опираются на неё для обмена эфемерными ключами. Она быстрая, не имеет неудобных ловушек при проверке параметров и обходит патентный и побочно-канальный балласт кривых NIST P.

Проблема была в том, что `ECDiffieHellman` в .NET построен вокруг именованных кривых и форматов точек SEC, а Curve25519 использует другую кодировку. Нельзя было просто передать аналог `ECCurve.NamedCurves.nistP256` и получить X25519. Поэтому каждый проект .NET, которому это требовалось, обращался к сторонней библиотеке со всеми вопросами цепочки поставок и обрезки AOT, которые это влечёт.

## Новая поверхность API

Preview 5 вводит `X25519DiffieHellman` ([предложение API dotnet/runtime#126206](https://github.com/dotnet/runtime/issues/126206)), абстрактный тип, который следует тому же фабричному шаблону, что и постквантовые классы `MLKem` и `MLDsa`. Ключи и общий секрет имеют фиксированный размер 32 байта.

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

Имя метода выбрано намеренно: `DeriveRawSecretAgreement` возвращает необработанный вывод X25519. Не используйте эти 32 байта напрямую как ключ шифрования. Сначала пропустите их через KDF, ровно как это делает TLS:

```csharp
byte[] key = HKDF.DeriveKey(
    HashAlgorithmName.SHA256,
    ikm: secretA,
    outputLength: 32,
    info: "my-app handshake v1"u8.ToArray());
```

## Куда это встраивается дальше

Вспомогательные методы импорта и экспорта покрывают весь набор, который вы ожидаете: `ExportPkcs8PrivateKey`, `ImportFromPem`, `ImportEncryptedPkcs8PrivateKey` и перегрузки на основе span для горячих путей. В Windows реализация опирается на CNG, в Linux на OpenSSL, с аннотациями `[SupportedOSPlatform]`, чтобы анализатор предупреждал вас о неподдерживаемых целях.

Самое интересное это сочетание с [постквантовыми примитивами .NET 10](/ru/2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa/). Гибридные рукопожатия, сочетающие X25519 с ML-KEM, это направление, в котором движется TLS, и теперь, когда обе половины встроены, вы можете построить такой обмен на чистом .NET без единой сторонней криптографической зависимости. Это и есть настоящая история Preview 5.
