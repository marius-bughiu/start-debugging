---
title: "X25519 Key Agreement Lands In-Box in .NET 11 Preview 5"
description: ".NET 11 Preview 5 adds a first-class X25519DiffieHellman type to System.Security.Cryptography, so you can do Curve25519 key exchange without BouncyCastle or NSec."
pubDate: 2026-06-13
tags:
  - "dotnet-11"
  - "csharp"
  - "cryptography"
  - "security"
---

The [.NET 11 Preview 5 announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) is heavy on LINQ and Blazor, but the line that matters most for anyone building secure transports is one bullet under cryptography: `System.Security.Cryptography` now ships X25519 key agreement in the box. Until this release, doing a Curve25519 Diffie-Hellman exchange in .NET meant pulling in BouncyCastle or NSec, because the built-in `ECDiffieHellman` never exposed Curve25519 in a portable, cross-platform way.

## Why Curve25519 Was the Awkward Gap

X25519 is the Diffie-Hellman function over Curve25519, and it is everywhere modern crypto happens: TLS 1.3, SSH, Signal, WireGuard, and Noise all lean on it for ephemeral key exchange. It is fast, has no awkward parameter-validation footguns, and sidesteps the patent and side-channel baggage of the NIST P-curves.

The problem was that `ECDiffieHellman` in .NET is built around named curves and the SEC point formats, and Curve25519 uses a different encoding. You could not just pass `ECCurve.NamedCurves.nistP256`'s cousin and get X25519. So every .NET project that needed it reached for a third-party library, with all the supply-chain and AOT-trimming questions that brings.

## The New API Surface

Preview 5 introduces `X25519DiffieHellman` ([API proposal dotnet/runtime#126206](https://github.com/dotnet/runtime/issues/126206)), an abstract type that follows the same factory pattern as the post-quantum `MLKem` and `MLDsa` classes. Keys and the shared secret are all a fixed 32 bytes.

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

The method name is deliberate: `DeriveRawSecretAgreement` returns the raw X25519 output. Do not use those 32 bytes directly as an encryption key. Run them through a KDF first, exactly as TLS does:

```csharp
byte[] key = HKDF.DeriveKey(
    HashAlgorithmName.SHA256,
    ikm: secretA,
    outputLength: 32,
    info: "my-app handshake v1"u8.ToArray());
```

## Where This Fits Next

The import and export helpers cover the full set you would expect: `ExportPkcs8PrivateKey`, `ImportFromPem`, `ImportEncryptedPkcs8PrivateKey`, and span-based overloads for hot paths. On Windows the implementation is backed by CNG, on Linux by OpenSSL, with `[SupportedOSPlatform]` annotations so the analyzer warns you on unsupported targets.

The interesting part is the pairing with [.NET 10's post-quantum primitives](/2026/02/dotnet-10-post-quantum-cryptography-ml-kem-ml-dsa-slh-dsa/). Hybrid handshakes that combine X25519 with ML-KEM are the direction TLS is heading, and with both halves now in the box, you can build that exchange in pure .NET without a single third-party crypto dependency. That is the real story in Preview 5.
