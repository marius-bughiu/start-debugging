---
title: "Постквантовая криптография в .NET 10: ML-KEM, ML-DSA и SLH-DSA"
description: ".NET 10 добавляет нативную поддержку постквантовых криптографических алгоритмов ML-KEM, ML-DSA и SLH-DSA, готовя ваши приложения к квантово-устойчивому будущему."
pubDate: 2026-02-08
tags:
  - "dotnet-10"
  - "cryptography"
  - "security"
  - "post-quantum"
lang: "ru"
translationOf: "2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa"
translatedBy: "claude"
translationDate: 2026-04-29
---

Квантовые компьютеры угрожают сломать криптографию RSA и эллиптических кривых. .NET 10 отвечает добавлением нативной поддержки трёх постквантовых алгоритмов, стандартизированных NIST: ML-KEM (FIPS 203), ML-DSA (FIPS 204) и SLH-DSA (FIPS 205).

## Почему постквантовая криптография важна уже сейчас

Современные асимметричные алгоритмы вроде RSA-2048 и ECDSA опираются на математические задачи, которые квантовые компьютеры умеют решать эффективно. Хотя крупномасштабных квантовых компьютеров пока не существует, атаки типа "собери сейчас, расшифруй потом" означают, что чувствительные данные, зашифрованные сегодня, могут быть раскрыты в будущем. В августе 2024 NIST финализировал свои первые постквантовые стандарты, и .NET 10 их реализует.

## ML-KEM для инкапсуляции ключей

ML-KEM (Module-Lattice-Based Key-Encapsulation Mechanism) заменяет протоколы обмена ключами вроде ECDH. Используйте его для установки общих секретов:

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

ML-KEM поставляется в трёх наборах параметров: MLKem512, MLKem768 и MLKem1024. MLKem768 даёт баланс между безопасностью и производительностью для большинства приложений.

## ML-DSA для цифровых подписей

ML-DSA (Module-Lattice-Based Digital Signature Algorithm) -- постквантовая замена подписей RSA и ECDSA:

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

Наборы параметров ML-DSA включают MLDsa44, MLDsa65 и MLDsa87. MLDsa65 обеспечивает уровень безопасности NIST 3, подходящий для большинства сценариев.

## SLH-DSA для долгосрочной безопасности

SLH-DSA (Stateless Hash-Based Digital Signature Algorithm) -- консервативная альтернатива ML-DSA. Он производит более крупные подписи, но опирается лишь на безопасность хеш-функции, что делает его пригодным для сценариев, требующих максимальной уверенности:

```csharp
using System.Security.Cryptography;

byte[] data = "Critical document"u8.ToArray();

using var slhDsa = SLHDsa.Create(SLHDsaParameterSet.SLHDsaSha2_128f);
byte[] signature = slhDsa.SignData(data);
bool isValid = slhDsa.VerifyData(data, signature);
```

Варианты "f" (fast) приоритизируют скорость подписания; варианты "s" (small) минимизируют размер подписи.

## Требования к платформе

Постквантовая криптография в .NET 10 требует:
- Windows 11 или Windows Server 2025 с обновлениями PQC
- Linux или macOS с OpenSSL 3.5+

На неподдерживаемых платформах методы `Create` бросают `PlatformNotSupportedException`.

## Гибридные подходы

В переходный период рассмотрите комбинирование классических и постквантовых алгоритмов. Если один сломан, другой по-прежнему обеспечивает защиту. Это особенно важно для долгоживущих сертификатов и архивных данных.

Полную документацию по API см. в [Post-quantum cryptography на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/overview#cryptography).
