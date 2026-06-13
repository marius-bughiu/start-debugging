---
title: "O acordo de chaves X25519 chega integrado ao .NET 11 Preview 5"
description: ".NET 11 Preview 5 adiciona um tipo X25519DiffieHellman de primeira classe ao System.Security.Cryptography, para fazer troca de chaves Curve25519 sem BouncyCastle ou NSec."
pubDate: 2026-06-13
tags:
  - "dotnet-11"
  - "csharp"
  - "cryptography"
  - "security"
lang: "pt-br"
translationOf: "2026/06/dotnet-11-x25519-key-agreement-preview-5"
translatedBy: "claude"
translationDate: 2026-06-13
---

O [anúncio do .NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) é carregado de LINQ e Blazor, mas a linha que mais importa para quem constrói transportes seguros é um item sob criptografia: o `System.Security.Cryptography` agora traz o acordo de chaves X25519 integrado. Até esta versão, fazer uma troca Diffie-Hellman sobre Curve25519 no .NET significava incluir BouncyCastle ou NSec, porque o `ECDiffieHellman` integrado nunca expôs Curve25519 de forma portável e multiplataforma.

## Por que Curve25519 era a lacuna incômoda

X25519 é a função Diffie-Hellman sobre Curve25519, e ela está em todo lugar onde a criptografia moderna acontece: TLS 1.3, SSH, Signal, WireGuard e Noise se apoiam nela para a troca de chaves efêmeras. É rápida, não tem armadilhas incômodas de validação de parâmetros e contorna o peso de patentes e de canais laterais das curvas NIST P.

O problema era que o `ECDiffieHellman` no .NET é construído em torno de curvas nomeadas e dos formatos de ponto SEC, e a Curve25519 usa uma codificação diferente. Você não podia simplesmente passar o primo de `ECCurve.NamedCurves.nistP256` e obter X25519. Então todo projeto .NET que precisava dela recorria a uma biblioteca de terceiros, com todas as questões de cadeia de suprimentos e de recorte AOT que isso traz.

## A nova superfície de API

O Preview 5 introduz o `X25519DiffieHellman` ([proposta de API dotnet/runtime#126206](https://github.com/dotnet/runtime/issues/126206)), um tipo abstrato que segue o mesmo padrão de fábrica das classes pós-quânticas `MLKem` e `MLDsa`. As chaves e o segredo compartilhado têm todos 32 bytes fixos.

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

O nome do método é deliberado: `DeriveRawSecretAgreement` devolve a saída X25519 em bruto. Não use esses 32 bytes diretamente como chave de criptografia. Passe-os primeiro por um KDF, exatamente como o TLS faz:

```csharp
byte[] key = HKDF.DeriveKey(
    HashAlgorithmName.SHA256,
    ikm: secretA,
    outputLength: 32,
    info: "my-app handshake v1"u8.ToArray());
```

## Onde isso se encaixa a seguir

Os auxiliares de importação e exportação cobrem o conjunto completo que você esperaria: `ExportPkcs8PrivateKey`, `ImportFromPem`, `ImportEncryptedPkcs8PrivateKey` e sobrecargas baseadas em span para caminhos quentes. No Windows a implementação é respaldada pelo CNG, no Linux pelo OpenSSL, com anotações `[SupportedOSPlatform]` para que o analisador avise você sobre alvos não suportados.

A parte interessante é o casamento com [as primitivas pós-quânticas do .NET 10](/pt-br/2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa/). Handshakes híbridos que combinam X25519 com ML-KEM são a direção para onde o TLS está indo, e com as duas metades agora integradas, você pode construir essa troca em .NET puro sem uma única dependência criptográfica de terceiros. Essa é a verdadeira história do Preview 5.
