---
title: "El acuerdo de claves X25519 llega integrado en .NET 11 Preview 5"
description: ".NET 11 Preview 5 agrega un tipo X25519DiffieHellman de primera clase a System.Security.Cryptography, para hacer intercambio de claves Curve25519 sin BouncyCastle ni NSec."
pubDate: 2026-06-13
tags:
  - "dotnet-11"
  - "csharp"
  - "cryptography"
  - "security"
lang: "es"
translationOf: "2026/06/dotnet-11-x25519-key-agreement-preview-5"
translatedBy: "claude"
translationDate: 2026-06-13
---

El [anuncio de .NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) está cargado de LINQ y Blazor, pero la línea que más importa para cualquiera que construya transportes seguros es una viñeta bajo criptografía: `System.Security.Cryptography` ahora incluye el acuerdo de claves X25519 de forma integrada. Hasta esta versión, hacer un intercambio Diffie-Hellman sobre Curve25519 en .NET significaba incorporar BouncyCastle o NSec, porque el `ECDiffieHellman` integrado nunca expuso Curve25519 de forma portable y multiplataforma.

## Por qué Curve25519 era el hueco incómodo

X25519 es la función Diffie-Hellman sobre Curve25519, y está en todas partes donde ocurre la criptografía moderna: TLS 1.3, SSH, Signal, WireGuard y Noise se apoyan en ella para el intercambio de claves efímeras. Es rápida, no tiene trampas incómodas de validación de parámetros, y esquiva la carga de patentes y de canales laterales de las curvas NIST P.

El problema era que `ECDiffieHellman` en .NET se construye en torno a curvas con nombre y a los formatos de punto SEC, y Curve25519 usa una codificación distinta. No podías simplemente pasar el primo de `ECCurve.NamedCurves.nistP256` y obtener X25519. Así que cada proyecto .NET que lo necesitaba recurría a una biblioteca de terceros, con todas las preguntas de cadena de suministro y de recorte AOT que eso conlleva.

## La nueva superficie de API

Preview 5 introduce `X25519DiffieHellman` ([propuesta de API dotnet/runtime#126206](https://github.com/dotnet/runtime/issues/126206)), un tipo abstracto que sigue el mismo patrón de fábrica que las clases poscuánticas `MLKem` y `MLDsa`. Las claves y el secreto compartido son todos de 32 bytes fijos.

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

El nombre del método es deliberado: `DeriveRawSecretAgreement` devuelve la salida X25519 en bruto. No uses esos 32 bytes directamente como clave de cifrado. Pásalos primero por un KDF, exactamente como hace TLS:

```csharp
byte[] key = HKDF.DeriveKey(
    HashAlgorithmName.SHA256,
    ikm: secretA,
    outputLength: 32,
    info: "my-app handshake v1"u8.ToArray());
```

## Dónde encaja esto a continuación

Los ayudantes de importación y exportación cubren el conjunto completo que esperarías: `ExportPkcs8PrivateKey`, `ImportFromPem`, `ImportEncryptedPkcs8PrivateKey` y sobrecargas basadas en span para rutas calientes. En Windows la implementación está respaldada por CNG, en Linux por OpenSSL, con anotaciones `[SupportedOSPlatform]` para que el analizador te avise sobre destinos no compatibles.

La parte interesante es el emparejamiento con [las primitivas poscuánticas de .NET 10](/es/2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa/). Los handshakes híbridos que combinan X25519 con ML-KEM son la dirección hacia la que va TLS, y con ambas mitades ahora integradas, puedes construir ese intercambio en .NET puro sin una sola dependencia criptográfica de terceros. Esa es la verdadera historia de Preview 5.
