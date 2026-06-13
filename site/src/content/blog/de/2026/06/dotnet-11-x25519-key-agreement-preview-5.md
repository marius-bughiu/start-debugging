---
title: "X25519-Schlüsselaustausch kommt integriert in .NET 11 Preview 5"
description: ".NET 11 Preview 5 fügt System.Security.Cryptography einen erstklassigen Typ X25519DiffieHellman hinzu, für Curve25519-Schlüsselaustausch ohne BouncyCastle oder NSec."
pubDate: 2026-06-13
tags:
  - "dotnet-11"
  - "csharp"
  - "cryptography"
  - "security"
lang: "de"
translationOf: "2026/06/dotnet-11-x25519-key-agreement-preview-5"
translatedBy: "claude"
translationDate: 2026-06-13
---

Die [Ankündigung zu .NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) ist voll von LINQ und Blazor, aber die Zeile, die für alle, die sichere Transporte bauen, am wichtigsten ist, ist ein Punkt unter Kryptografie: `System.Security.Cryptography` liefert den X25519-Schlüsselaustausch jetzt integriert mit. Bis zu dieser Version bedeutete ein Diffie-Hellman-Austausch über Curve25519 in .NET, BouncyCastle oder NSec einzubinden, weil das integrierte `ECDiffieHellman` Curve25519 nie portabel und plattformübergreifend bereitstellte.

## Warum Curve25519 die unbequeme Lücke war

X25519 ist die Diffie-Hellman-Funktion über Curve25519, und sie ist überall dort, wo moderne Kryptografie stattfindet: TLS 1.3, SSH, Signal, WireGuard und Noise stützen sich für den Austausch flüchtiger Schlüssel darauf. Sie ist schnell, hat keine unbequemen Stolperfallen bei der Parametervalidierung und umgeht den Patent- und Seitenkanal-Ballast der NIST-P-Kurven.

Das Problem war, dass `ECDiffieHellman` in .NET um benannte Kurven und die SEC-Punktformate herum aufgebaut ist, und Curve25519 eine andere Kodierung verwendet. Sie konnten nicht einfach das Pendant zu `ECCurve.NamedCurves.nistP256` übergeben und X25519 erhalten. Also griff jedes .NET-Projekt, das es brauchte, zu einer Drittanbieter-Bibliothek, mit allen Fragen zu Lieferkette und AOT-Trimming, die das mit sich bringt.

## Die neue API-Oberfläche

Preview 5 führt `X25519DiffieHellman` ein ([API-Vorschlag dotnet/runtime#126206](https://github.com/dotnet/runtime/issues/126206)), ein abstrakter Typ, der demselben Factory-Muster folgt wie die postquantenkryptografischen Klassen `MLKem` und `MLDsa`. Schlüssel und das gemeinsame Geheimnis sind alle fest 32 Byte groß.

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

Der Methodenname ist bewusst gewählt: `DeriveRawSecretAgreement` gibt die rohe X25519-Ausgabe zurück. Verwenden Sie diese 32 Byte nicht direkt als Verschlüsselungsschlüssel. Leiten Sie sie zuerst durch eine KDF, genau wie TLS es tut:

```csharp
byte[] key = HKDF.DeriveKey(
    HashAlgorithmName.SHA256,
    ikm: secretA,
    outputLength: 32,
    info: "my-app handshake v1"u8.ToArray());
```

## Wo das als Nächstes hinpasst

Die Import- und Export-Helfer decken den vollständigen Satz ab, den Sie erwarten würden: `ExportPkcs8PrivateKey`, `ImportFromPem`, `ImportEncryptedPkcs8PrivateKey` und span-basierte Überladungen für heiße Pfade. Unter Windows wird die Implementierung von CNG getragen, unter Linux von OpenSSL, mit `[SupportedOSPlatform]`-Annotationen, damit der Analyzer Sie bei nicht unterstützten Zielen warnt.

Der interessante Teil ist die Kombination mit [den postquantenkryptografischen Primitiven von .NET 10](/de/2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa/). Hybride Handshakes, die X25519 mit ML-KEM kombinieren, sind die Richtung, in die TLS geht, und da nun beide Hälften integriert sind, können Sie diesen Austausch in reinem .NET ohne eine einzige Krypto-Abhängigkeit von Drittanbietern bauen. Das ist die eigentliche Geschichte in Preview 5.
