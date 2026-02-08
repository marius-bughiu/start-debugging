---
title: "How to publish container as tar.gz in .NET"
description: "Learn how to publish a .NET 8 container as a tar.gz archive using the ContainerArchiveOutputPath property with dotnet publish."
pubDate: 2023-11-11
tags:
  - "docker"
  - "dotnet"
---
Starting with .NET 8, it’s possible to directly generate a tar.gz container archive. This is particularly advantageous for more complex workflows where activities like scanning the images before pushing them are needed. After creating the archive, it can be transferred, scanned, or incorporated into your local Docker setup.

For archiving during publication, integrate the `ContainerArchiveOutputPath` attribute into your dotnet publish instruction. For instance:

```bash
dotnet publish \
  -p PublishProfile=DefaultContainer \
  -p ContainerArchiveOutputPath=./containers/my-container.tar.gz
```
