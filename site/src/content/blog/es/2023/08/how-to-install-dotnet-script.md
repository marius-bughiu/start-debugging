---
title: "Cómo instalar dotnet script"
description: "dotnet script te permite ejecutar scripts de C# (.CSX) desde la CLI de .NET. El único requisito es tener instalado .NET 6 o más reciente en tu máquina. Puedes usar el siguiente comando para instalar dotnet-script de forma global: Luego, para ejecutar un archivo de script, basta con llamar a dotnet script <file_path>, como en el siguiente ejemplo: Cómo..."
pubDate: 2023-08-29
updatedDate: 2023-11-05
tags:
  - "dotnet-script"
  - "dotnet"
lang: "es"
translationOf: "2023/08/how-to-install-dotnet-script"
translatedBy: "claude"
translationDate: 2026-05-01
---
`dotnet script` te permite ejecutar scripts de C# (`.CSX`) desde la CLI de .NET. El único requisito es tener instalado .NET 6 o más reciente en tu máquina.

Puedes usar el siguiente comando para instalar dotnet-script de forma global:

```bash
dotnet tool install -g dotnet-script
```

Luego, para ejecutar un archivo de script, basta con llamar a `dotnet script <file_path>`, como en el siguiente ejemplo:

```bash
dotnet script startdebugging.csx
```

## Cómo inicializar un nuevo dotnet script

Si estás empezando y quieres crear un nuevo archivo de dotnet script, puedes usar el comando `init` para generar un proyecto de script.

```bash
dotnet script init startdebugging.csx
```

Esto creará tu archivo de script junto con la configuración de lanzamiento necesaria para depurarlo en VS Code. Ten en cuenta que el nombre del archivo es opcional y, si no lo especificas, será `main.csx` por defecto.

```plaintext
. 
├── .vscode 
│   └── launch.json 
├── startdebugging.csx 
└── omnisharp.json
```

## Usings implícitos

dotnet script viene con algunos espacios de nombres incluidos por defecto, similar a la característica de implicit usings que conoces de los proyectos del .NET SDK. A continuación tienes la lista completa de namespaces disponibles de forma implícita en dotnet-script.

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
