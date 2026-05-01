---
title: "Como instalar o dotnet script"
description: "dotnet script permite executar scripts C# (.CSX) a partir da CLI do .NET. O único requisito é ter o .NET 6 ou mais recente instalado na sua máquina. Você pode usar o comando abaixo para instalar o dotnet-script globalmente: Depois, para executar um arquivo de script, basta rodar dotnet script <file_path>, como no exemplo abaixo: Como..."
pubDate: 2023-08-29
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/08/how-to-install-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
`dotnet script` permite executar scripts C# (`.CSX`) a partir da CLI do .NET. O único requisito é ter o .NET 6 ou mais recente instalado na sua máquina.

Você pode usar o comando abaixo para instalar o dotnet-script globalmente:

```bash
dotnet tool install -g dotnet-script
```

Depois, para executar um arquivo de script, basta rodar `dotnet script <file_path>`, como no exemplo abaixo:

```bash
dotnet script startdebugging.csx
```

## Como inicializar um novo dotnet script

Se você está começando e quer criar um novo arquivo de dotnet script, dá para usar o comando `init` para gerar um projeto de script.

```bash
dotnet script init startdebugging.csx
```

Isso cria o arquivo de script junto com a configuração de launch necessária para depurar o script no VS Code. O nome do arquivo é opcional; se você não passar, ele assume `main.csx` como padrão.

```plaintext
. 
├── .vscode 
│   └── launch.json 
├── startdebugging.csx 
└── omnisharp.json
```

## Usings implícitos

dotnet script já vem com alguns namespaces incluídos por padrão, parecido com a feature de implicit usings dos projetos do .NET SDK. Abaixo está a lista completa de namespaces disponíveis de forma implícita no dotnet-script.

```cs
System
System.IO
System.Collections.Generic
System.Console
System.Diagnostics
System.Dynamic
System.Linq
System.Linq.Expressions
System.Text
System.Threading.Tasks
```
