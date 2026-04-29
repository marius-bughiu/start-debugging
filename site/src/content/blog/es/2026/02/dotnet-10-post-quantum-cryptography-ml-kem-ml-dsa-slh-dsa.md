---
title: "Criptografía post-cuántica en .NET 10: ML-KEM, ML-DSA y SLH-DSA"
description: ".NET 10 añade soporte nativo para los algoritmos de criptografía post-cuántica ML-KEM, ML-DSA y SLH-DSA, preparando tus aplicaciones para un futuro resistente a la computación cuántica."
pubDate: 2026-02-08
tags:
  - "dotnet-10"
  - "cryptography"
  - "security"
  - "post-quantum"
lang: "es"
translationOf: "2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa"
translatedBy: "claude"
translationDate: 2026-04-29
---

Las computadoras cuánticas amenazan con romper la criptografía RSA y de curva elíptica. .NET 10 responde añadiendo soporte nativo para tres algoritmos post-cuánticos estandarizados por NIST: ML-KEM (FIPS 203), ML-DSA (FIPS 204) y SLH-DSA (FIPS 205).

## Por qué la criptografía post-cuántica importa ahora

Los algoritmos asimétricos actuales como RSA-2048 y ECDSA dependen de problemas matemáticos que las computadoras cuánticas pueden resolver eficientemente. Aunque las computadoras cuánticas a gran escala todavía no existen, los ataques de tipo "harvest now, decrypt later" significan que los datos sensibles cifrados hoy podrían quedar expuestos en el futuro. NIST finalizó sus primeros estándares post-cuánticos en agosto de 2024, y .NET 10 los implementa.

## ML-KEM para encapsulación de claves

ML-KEM (Module-Lattice-Based Key-Encapsulation Mechanism) reemplaza protocolos de intercambio de claves como ECDH. Úsalo para establecer secretos compartidos:

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

ML-KEM viene en tres conjuntos de parámetros: MLKem512, MLKem768 y MLKem1024. MLKem768 ofrece un equilibrio entre seguridad y rendimiento para la mayoría de las aplicaciones.

## ML-DSA para firmas digitales

ML-DSA (Module-Lattice-Based Digital Signature Algorithm) es el reemplazo post-cuántico para las firmas RSA y ECDSA:

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

Los conjuntos de parámetros de ML-DSA incluyen MLDsa44, MLDsa65 y MLDsa87. MLDsa65 proporciona el Nivel de Seguridad NIST 3, adecuado para la mayoría de los casos de uso.

## SLH-DSA para seguridad a largo plazo

SLH-DSA (Stateless Hash-Based Digital Signature Algorithm) es una alternativa conservadora a ML-DSA. Produce firmas más grandes pero depende solo de la seguridad de la función hash, lo que lo hace adecuado para escenarios que requieren máxima confianza:

```csharp
using System.Security.Cryptography;

byte[] data = "Critical document"u8.ToArray();

using var slhDsa = SLHDsa.Create(SLHDsaParameterSet.SLHDsaSha2_128f);
byte[] signature = slhDsa.SignData(data);
bool isValid = slhDsa.VerifyData(data, signature);
```

Las variantes "f" (fast) priorizan la velocidad de firma; las variantes "s" (small) minimizan el tamaño de la firma.

## Requisitos de plataforma

La criptografía post-cuántica en .NET 10 requiere:
- Windows 11 o Windows Server 2025 con actualizaciones PQC
- Linux o macOS con OpenSSL 3.5+

En plataformas no soportadas, los métodos `Create` lanzan `PlatformNotSupportedException`.

## Enfoques híbridos

Durante el período de transición, considera combinar algoritmos clásicos y post-cuánticos. Si uno se rompe, el otro sigue proporcionando protección. Esto es especialmente importante para certificados de larga duración y datos archivados.

Para documentación completa de la API, ver [Post-quantum cryptography en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/overview#cryptography).
