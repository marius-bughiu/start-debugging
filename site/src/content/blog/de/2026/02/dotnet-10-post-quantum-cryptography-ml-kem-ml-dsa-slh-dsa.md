---
title: "Post-Quanten-Kryptografie in .NET 10: ML-KEM, ML-DSA und SLH-DSA"
description: ".NET 10 ergänzt native Unterstützung für die Post-Quanten-Algorithmen ML-KEM, ML-DSA und SLH-DSA und bereitet Ihre Anwendungen so auf eine quantenresistente Zukunft vor."
pubDate: 2026-02-08
tags:
  - "dotnet-10"
  - "cryptography"
  - "security"
  - "post-quantum"
lang: "de"
translationOf: "2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa"
translatedBy: "claude"
translationDate: 2026-04-29
---

Quantencomputer drohen, RSA und elliptische-Kurven-Kryptografie zu brechen. .NET 10 antwortet darauf mit nativer Unterstützung für drei vom NIST standardisierte Post-Quanten-Algorithmen: ML-KEM (FIPS 203), ML-DSA (FIPS 204) und SLH-DSA (FIPS 205).

## Warum Post-Quanten-Kryptografie jetzt zählt

Aktuelle asymmetrische Algorithmen wie RSA-2048 und ECDSA stützen sich auf mathematische Probleme, die Quantencomputer effizient lösen können. Großmaßstäbliche Quantencomputer existieren noch nicht, doch "Harvest-now-decrypt-later"-Angriffe bedeuten, dass heute verschlüsselte sensible Daten in Zukunft offengelegt werden könnten. NIST hat seine ersten Post-Quanten-Standards im August 2024 finalisiert, und .NET 10 setzt sie um.

## ML-KEM für Schlüsselkapselung

ML-KEM (Module-Lattice-Based Key-Encapsulation Mechanism) ersetzt Schlüsselaustauschprotokolle wie ECDH. Verwenden Sie es, um gemeinsame Geheimnisse zu etablieren:

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

ML-KEM gibt es in drei Parametersätzen: MLKem512, MLKem768 und MLKem1024. MLKem768 bietet für die meisten Anwendungen ein ausgewogenes Verhältnis zwischen Sicherheit und Performance.

## ML-DSA für digitale Signaturen

ML-DSA (Module-Lattice-Based Digital Signature Algorithm) ist der Post-Quanten-Ersatz für RSA- und ECDSA-Signaturen:

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

Zu den ML-DSA-Parametersätzen gehören MLDsa44, MLDsa65 und MLDsa87. MLDsa65 bietet NIST-Sicherheitsstufe 3, geeignet für die meisten Anwendungsfälle.

## SLH-DSA für langfristige Sicherheit

SLH-DSA (Stateless Hash-Based Digital Signature Algorithm) ist eine konservative Alternative zu ML-DSA. Es erzeugt größere Signaturen, stützt sich aber ausschließlich auf die Sicherheit von Hashfunktionen, wodurch es sich für Szenarien eignet, die maximales Vertrauen erfordern:

```csharp
using System.Security.Cryptography;

byte[] data = "Critical document"u8.ToArray();

using var slhDsa = SLHDsa.Create(SLHDsaParameterSet.SLHDsaSha2_128f);
byte[] signature = slhDsa.SignData(data);
bool isValid = slhDsa.VerifyData(data, signature);
```

Die "f"-Varianten (fast) priorisieren Signiergeschwindigkeit; die "s"-Varianten (small) minimieren die Signaturgröße.

## Plattformanforderungen

Post-Quanten-Kryptografie in .NET 10 erfordert:
- Windows 11 oder Windows Server 2025 mit PQC-Updates
- Linux oder macOS mit OpenSSL 3.5+

Auf nicht unterstützten Plattformen werfen die `Create`-Methoden `PlatformNotSupportedException`.

## Hybride Ansätze

Erwägen Sie während der Übergangsphase, klassische und Post-Quanten-Algorithmen zu kombinieren. Wird einer gebrochen, bietet der andere weiterhin Schutz. Das ist besonders wichtig für langlebige Zertifikate und archivierte Daten.

Die vollständige API-Dokumentation finden Sie unter [Post-quantum cryptography auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/overview#cryptography).
