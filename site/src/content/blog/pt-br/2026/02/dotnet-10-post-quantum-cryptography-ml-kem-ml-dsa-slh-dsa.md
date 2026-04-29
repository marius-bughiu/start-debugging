---
title: "Criptografia pós-quântica no .NET 10: ML-KEM, ML-DSA e SLH-DSA"
description: "O .NET 10 adiciona suporte nativo aos algoritmos de criptografia pós-quântica ML-KEM, ML-DSA e SLH-DSA, preparando suas aplicações para um futuro resistente a computadores quânticos."
pubDate: 2026-02-08
tags:
  - "dotnet-10"
  - "cryptography"
  - "security"
  - "post-quantum"
lang: "pt-br"
translationOf: "2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa"
translatedBy: "claude"
translationDate: 2026-04-29
---

Computadores quânticos ameaçam quebrar a criptografia RSA e a de curvas elípticas. O .NET 10 responde adicionando suporte nativo a três algoritmos pós-quânticos padronizados pelo NIST: ML-KEM (FIPS 203), ML-DSA (FIPS 204) e SLH-DSA (FIPS 205).

## Por que a criptografia pós-quântica importa agora

Algoritmos assimétricos atuais como RSA-2048 e ECDSA dependem de problemas matemáticos que computadores quânticos conseguem resolver de forma eficiente. Embora computadores quânticos em larga escala ainda não existam, ataques do tipo "colete agora, decifre depois" significam que dados sensíveis criptografados hoje podem ser expostos no futuro. O NIST finalizou seus primeiros padrões pós-quânticos em agosto de 2024, e o .NET 10 os implementa.

## ML-KEM para encapsulamento de chaves

ML-KEM (Module-Lattice-Based Key-Encapsulation Mechanism) substitui protocolos de troca de chaves como ECDH. Use-o para estabelecer segredos compartilhados:

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

O ML-KEM vem em três conjuntos de parâmetros: MLKem512, MLKem768 e MLKem1024. O MLKem768 oferece um equilíbrio entre segurança e desempenho para a maioria das aplicações.

## ML-DSA para assinaturas digitais

ML-DSA (Module-Lattice-Based Digital Signature Algorithm) é o substituto pós-quântico para assinaturas RSA e ECDSA:

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

Os conjuntos de parâmetros do ML-DSA incluem MLDsa44, MLDsa65 e MLDsa87. O MLDsa65 oferece o Nível de Segurança NIST 3, adequado para a maioria dos casos de uso.

## SLH-DSA para segurança de longo prazo

SLH-DSA (Stateless Hash-Based Digital Signature Algorithm) é uma alternativa conservadora ao ML-DSA. Produz assinaturas maiores mas depende apenas da segurança da função de hash, o que o torna adequado para cenários que exigem confiança máxima:

```csharp
using System.Security.Cryptography;

byte[] data = "Critical document"u8.ToArray();

using var slhDsa = SLHDsa.Create(SLHDsaParameterSet.SLHDsaSha2_128f);
byte[] signature = slhDsa.SignData(data);
bool isValid = slhDsa.VerifyData(data, signature);
```

As variantes "f" (fast) priorizam a velocidade de assinatura; as variantes "s" (small) minimizam o tamanho da assinatura.

## Requisitos de plataforma

A criptografia pós-quântica no .NET 10 requer:
- Windows 11 ou Windows Server 2025 com atualizações PQC
- Linux ou macOS com OpenSSL 3.5+

Em plataformas não suportadas, os métodos `Create` lançam `PlatformNotSupportedException`.

## Abordagens híbridas

Durante o período de transição, considere combinar algoritmos clássicos e pós-quânticos. Se um for quebrado, o outro ainda fornece proteção. Isso é especialmente importante para certificados de longa duração e dados arquivados.

Para a documentação completa da API, veja [Post-quantum cryptography no Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/overview#cryptography).
