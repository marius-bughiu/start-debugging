---
title: "Azure MCP Server 3.0 rechaza los parámetros desconocidos y crea los recursos seguros por defecto"
description: "Azure MCP Server 3.0.0 se lanzó el 12 de octubre de 2026. Las llamadas a herramientas con parámetros desconocidos ahora fallan, se eliminaron opciones como subscription y tenant de muchas herramientas, las nuevas cuentas de Storage desactivan la autenticación Shared Key y el servidor habla el protocolo MCP 2026-07-28 sin estado."
pubDate: 2026-10-13
tags:
  - "mcp"
  - "azure"
  - "dotnet"
  - "ai-agents"
lang: "es"
translationOf: "2026/10/azure-mcp-server-3-0-rejects-unknown-parameters-and-goes-secure-by-default"
translatedBy: "claude"
translationDate: 2026-10-13
---

[Azure MCP Server 3.0.0](https://github.com/microsoft/mcp/releases/tag/Azure.Mcp.Server-3.0.0) salió el 12 de octubre de 2026, después de 50 compilaciones beta. Lo más visible es un montón de namespaces nuevos (`azurebackup`, `resiliency`, `sreagent`, `azureterraform`, `advisor`, `iothub`), pero lo que hoy puede romper una configuración que funciona es más discreto: los contratos de las herramientas se volvieron más estrictos y los recursos que crea el servidor quedan blindados por defecto.

## Los parámetros desconocidos ahora son un error

En 2.x, una herramienta ignoraba en silencio las opciones que no usaba. 3.0 elimina parámetros sin uso como `subscription`, `resource-group`, `tenant`, `auth-method`, `user` y `sender-name` de las herramientas de casi todos los namespaces (Key Vault, Storage, SQL, Redis, Service Bus, AKS y más), y luego rechaza cualquier llamada que aún los pase. Las opciones de política de reintentos personalizada también desaparecieron; se aplican los valores por defecto de reintentos del SDK de Azure.

Esto importa si ejecutas `azmcp` desde scripts, o si guardaste prompts e instrucciones de agente que le indican al modelo que siempre pase una suscripción. Una llamada que funcionaba en 2.x así:

```bash
azmcp keyvault secret get --subscription 00000000-0000-0000-0000-000000000000 \
  --vault my-vault --secret db-password --retry-max-retries 5
```

ahora falla la validación en 3.0: `keyvault secret get` solo acepta `--vault` y un `--secret` opcional, y las opciones globales `--retry-*` ya no existen. Quítalas y revisa la [referencia de comandos](https://github.com/microsoft/mcp/blob/release/azure/3.x/servers/Azure.Mcp.Server/docs/azmcp-commands.md) para ver qué recibe realmente cada herramienta. Además, algunos resultados se normalizaron a objetos con nombre (`{ servers }`, `{ results }`, `{ guidance }`), así que los parsers que leen las formas antiguas necesitan una revisión.

Hay dos renombrados más que tener en cuenta: `monitor healthmodels entity get` pasó a ser `list` y `get`, y el código del servidor se movió de `Azure.Mcp.Core.*` a `Microsoft.Mcp.Core.*`. Las categorías del logger siguen a los namespaces, así que una entrada `Logging:LogLevel:Azure.Mcp.Core` en tu configuración deja de coincidir con nada.

## Creación de recursos segura por defecto

Cuando un agente crea recursos a través del servidor, cambiaron los valores por defecto:

- Las cuentas de Storage desactivan la autenticación Shared Key (HTTPS, TLS 1.2 y el acceso anónimo a blobs deshabilitado se mantienen).
- Los namespaces de Event Hubs desactivan la autenticación local.
- Los recursos compartidos de archivos NFS usan `RootSquash` por defecto con tránsito cifrado.
- `compute vm create` y `compute vmss create` requieren `--image`; los alias `Win2019Datacenter` y `Ubuntu2004` se eliminaron.

Si el código downstream se conecta con una clave de cuenta o con un SAS firmado por una, recibirá un 403 contra una cuenta recién creada. Ese es el objetivo: usa Entra ID y `DefaultAzureCredential`.

Las herramientas `database query` de MySQL y PostgreSQL cambiaron en el sentido contrario. Ahora están marcadas como destructivas, ya no filtran las sentencias por verbo SQL y dependen de los permisos de base de datos del usuario con sesión iniciada. Ejecuta el servidor con `--read-only` o usa un login de base de datos de solo lectura si el agente solo debe consultar.

## Protocolo sin estado y salida estructurada

3.0 pasa al protocolo sin estado `2026-07-28` de MCP y mantiene la compatibilidad con clientes en `2025-11-25`. Si no has seguido esa revisión, expliqué qué desaparece (sin handshake `initialize`, sin `Mcp-Session-Id`) en [servidores MCP con estado vs sin estado](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/).

Las herramientas ahora también pueden devolver `outputSchema` y `structuredContent`, con activación mediante una opción. Con `dnx` de .NET 10, la entrada de `mcp.json` queda así:

```json
{
  "mcpServers": {
    "azure-mcp-server": {
      "command": "dnx",
      "args": [
        "Azure.Mcp", "--version", "3.0.0", "--yes", "--",
        "azmcp", "server", "start",
        "--read-only",
        "--structured-output-mode", "compact"
      ],
      "type": "stdio"
    }
  }
}
```

`compact` envía texto corto en `content` y el resultado completo en `structuredContent`; `duplicated` envía el resultado completo en ambos. Actívalo solo si tu cliente entiende esos campos.

## Correcciones menores que justifican la actualización

Los mensajes de registro y las excepciones que se filtraban a stdout (y podían corromper la salida JSON-RPC) ahora van a stderr, los errores de recurso no encontrado devuelven 404 en lugar de 500, y el wrapper de npm ya no edita el `package.json` del proyecto que lo invoca cuando instala automáticamente un paquete de plataforma. Fija `Azure.Mcp` 3.0.0 o `@azure/mcp@3.0.0` de forma explícita en lugar de `@latest` hasta que tus scripts y prompts estén limpios.
