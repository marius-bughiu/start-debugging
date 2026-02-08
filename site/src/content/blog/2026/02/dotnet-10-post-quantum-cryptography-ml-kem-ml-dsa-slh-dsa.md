---
title: ".NET 10 Post-Quantum Cryptography: ML-KEM, ML-DSA, and SLH-DSA"
description: ".NET 10 adds native support for post-quantum cryptography algorithms ML-KEM, ML-DSA, and SLH-DSA, preparing your applications for a quantum-resistant future."
pubDate: 2026-02-08
tags:
  - "net-10"
  - "cryptography"
  - "security"
  - "post-quantum"
---

Quantum computers threaten to break RSA and elliptic curve cryptography. .NET 10 responds by adding native support for three NIST-standardized post-quantum algorithms: ML-KEM (FIPS 203), ML-DSA (FIPS 204), and SLH-DSA (FIPS 205).

## Why Post-Quantum Cryptography Matters Now

Current asymmetric algorithms like RSA-2048 and ECDSA rely on mathematical problems that quantum computers can solve efficiently. While large-scale quantum computers don't exist yet, "harvest now, decrypt later" attacks mean sensitive data encrypted today could be exposed in the future. NIST finalized its first post-quantum standards in August 2024, and .NET 10 implements them.

## ML-KEM for Key Encapsulation

ML-KEM (Module-Lattice-Based Key-Encapsulation Mechanism) replaces key exchange protocols like ECDH. Use it to establish shared secrets:

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

ML-KEM comes in three parameter sets: MLKem512, MLKem768, and MLKem1024. MLKem768 offers a balance between security and performance for most applications.

## ML-DSA for Digital Signatures

ML-DSA (Module-Lattice-Based Digital Signature Algorithm) is the post-quantum replacement for RSA and ECDSA signatures:

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

ML-DSA parameter sets include MLDsa44, MLDsa65, and MLDsa87. MLDsa65 provides NIST Security Level 3, suitable for most use cases.

## SLH-DSA for Long-Term Security

SLH-DSA (Stateless Hash-Based Digital Signature Algorithm) is a conservative alternative to ML-DSA. It produces larger signatures but relies only on hash function security, making it suitable for scenarios requiring maximum confidence:

```csharp
using System.Security.Cryptography;

byte[] data = "Critical document"u8.ToArray();

using var slhDsa = SLHDsa.Create(SLHDsaParameterSet.SLHDsaSha2_128f);
byte[] signature = slhDsa.SignData(data);
bool isValid = slhDsa.VerifyData(data, signature);
```

The "f" variants (fast) prioritize signing speed; "s" variants (small) minimize signature size.

## Platform Requirements

Post-quantum cryptography in .NET 10 requires:
- Windows 11 or Windows Server 2025 with PQC updates
- Linux or macOS with OpenSSL 3.5+

On unsupported platforms, the `Create` methods throw `PlatformNotSupportedException`.

## Hybrid Approaches

During the transition period, consider combining classical and post-quantum algorithms. If one is broken, the other still provides protection. This is especially important for long-lived certificates and archived data.

For complete API documentation, see [Post-quantum cryptography on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/overview#cryptography).
