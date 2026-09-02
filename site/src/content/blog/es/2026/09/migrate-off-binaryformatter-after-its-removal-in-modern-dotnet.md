---
title: "Migrar fuera de BinaryFormatter tras su eliminación en .NET moderno"
description: "La implementación de BinaryFormatter se eliminó en .NET 9 y sigue lanzando PlatformNotSupportedException en .NET 10 y .NET 11: cómo elegir un serializador de reemplazo, leer blobs NRBF ya persistidos con NrbfDecoder y qué se rompe en WinForms, WPF y ResX."
pubDate: 2026-09-02
updatedDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "binaryformatter"
  - "serialization"
  - "system-text-json"
  - "dotnet-10"
  - "dotnet-11"
  - "security"
  - "dotnet"
lang: "es"
translationOf: "2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet"
translatedBy: "claude"
translationDate: 2026-09-02
---

Un servicio que serializa sus propios tipos en su propio almacenamiento tarda de uno a tres días en salir de `BinaryFormatter`. Un código donde los payloads NRBF cruzaron un límite que no controlas (una cola, una columna de base de datos compartida, un cliente de escritorio que se publica con su propio calendario) tarda semanas, porque la parte difícil no es cambiar el serializador, es drenar los payloads viejos. La implementación incluida se eliminó en .NET 9 Preview 6 y sigue eliminada: en .NET 9, .NET 10 y .NET 11 preview, `BinaryFormatter.Serialize` y `BinaryFormatter.Deserialize` lanzan [`PlatformNotSupportedException`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal) para cualquier tipo de proyecto, y la vieja propiedad de MSBuild `EnableUnsafeBinaryFormatterSerialization` por sí sola ya no lo revive. Esta guía está escrita contra .NET 10.0.11 (GA) con notas para el SDK de .NET 11 (preview 7, agosto de 2026), `System.Formats.Nrbf` 10.0.11 y `System.Runtime.Serialization.Formatters` 10.0.11.

## Por qué esto no es opcional

- **Ya no queda ningún flag.** En .NET 8 el interruptor de desactivación pasó a estar activo por omisión y `<EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>` todavía funcionaba. Desde .NET 9 la propiedad por sí sola es inerte; el código que implementaba la funcionalidad ni siquiera está en el framework compartido.
- **El paquete de compatibilidad es explícitamente no soportado.** `System.Runtime.Serialization.Formatters` publica una implementación funcional, vulnerabilidades incluidas. Es un parche para llegar a una fecha límite, no un destino.
- **El riesgo es el formato, no los bugs.** NRBF codifica dentro del payload qué tipos hay que instanciar, lo que corresponde a [CWE-502, "Deserialization of Untrusted Data"](https://cwe.mitre.org/data/definitions/502.html). Ninguna cantidad de parches arregla un formato cuyo trabajo es dejar que el payload elija el constructor.
- **Puedes leer los blobs viejos sin deserializarlos.** `NrbfDecoder`, publicado en .NET 9 junto con la eliminación, decodifica NRBF en registros sin cargar un solo tipo personalizado. Eso es lo que hace posible una migración por fases en lugar de un corte de golpe.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| `BinaryFormatter.Serialize` / `Deserialize` | Lanza `PlatformNotSupportedException` en cada llamada, en todos los tipos de proyecto | alta |
| `EnableUnsafeBinaryFormatterSerialization` | Ya no basta por sí sola; también necesita el paquete de compatibilidad | alta |
| Blobs NRBF persistidos | Nada en el framework los va a deserializar ya | alta |
| `SoapFormatter`, `NetDataContractSerializer` | Eliminados o clasificados como [serializadores peligrosos](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-security-guide); no son un destino de migración | alta |
| Portapapeles y arrastrar y soltar en WinForms/WPF | Solo una lista de tipos intrínsecos hace el viaje de ida y vuelta. `DataFormats.Serializable` y los formatos personalizados fallan con cualquier otra cosa | alta |
| Diseñador de WinForms / ResX | La serialización en tiempo de diseño de un tipo personalizado necesita un `TypeConverter` | media |
| `Exception(SerializationInfo, StreamingContext)` | Obsoleto como `SYSLIB0051`; la serialización heredada de excepciones es peso muerto | media |
| `MSB3825` de MSBuild | Advertencia sobre recursos con formato binario; se suprime con `GenerateResourceWarnOnBinaryFormatterUse` | baja |
| `SettingsPropertyValue.PropertyValue` | Es de tipo `object`, así que la configuración de usuario de `System.Configuration` con tipos personalizados no se puede migrar sin romper la API | alta |

## Lista de verificación previa

- SDK de .NET 10.0.100 o posterior instalado (`dotnet --list-sdks`).
- Un inventario: `grep -rn "BinaryFormatter\|IFormatter\|SoapFormatter\|NetDataContractSerializer" --include=*.cs .` más un escaneo de tus dependencias NuGet, porque los llamadores transitivos son los que sorprenden.
- Pruebas de ida y vuelta alrededor de cada límite de serialización **antes** de tocar nada. Los bugs de serialización son silenciosos; aparecen como un campo nulo tres versiones después.
- Una muestra de payloads persistidos reales sacados del almacenamiento de producción. Los payloads sintéticos no ejercitan la deriva de versiones.
- Una decisión, escrita, sobre si controlas tanto el productor como el consumidor de cada payload. Si no, necesitas la ruta de lectura dual del paso 4, no un cambio directo.

## Pasos de migración

1. **Inventaría cada límite de payload, no cada sitio de llamada.** Agrupa los usos de `BinaryFormatter` según a dónde van los bytes: solo en memoria (un ayudante de clonación profunda), caché local al proceso, almacenamiento duradero (columna de base de datos, blob, archivo en disco) y entre procesos (portapapeles, cola, RPC estilo remoting). Los usos en memoria y locales al proceso se pueden cambiar en un solo commit. Los duraderos y entre procesos necesitan una ventana de transición de formato. Anota el conjunto cerrado de tipos que llegan a cada límite.

   Verificación: cada coincidencia del `grep` anterior está asignada exactamente a uno de los cuatro grupos, y cada límite duradero tiene un responsable con nombre y una lista con nombre de los tipos serializados.

2. **Elige el serializador de reemplazo por límite.** No hay un reemplazo directo, y no tienes que elegir el mismo en todas partes. La [comparación oficial](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer) se resume así: `System.Text.Json` cuando el payload puede ser texto y puedes anotar los tipos (la única opción de la lista con soporte AOT de primera clase y generación de código fuente); `DataContractSerializer` cuando no puedes cambiar los tipos en absoluto, porque es el único serializador recomendado que respeta `[Serializable]` e `ISerializable`; [MessagePack for C#](https://github.com/MessagePack-CSharp/MessagePack-CSharp) o [protobuf-net](https://github.com/protobuf-net/protobuf-net) cuando el payload tiene que seguir siendo binario compacto.

   Verificación: cada límite del paso 1 tiene un serializador anotado al lado, con una razón de una línea. Si la razón es "era el que estaba por omisión", vuelve atrás.

3. **Cambia primero los usos en memoria y locales al proceso.** Son ganancias gratis y reducen la superficie de los pasos difíciles. Un tipo `[Serializable]` que pasa a `System.Text.Json` necesita opt-in explícito para todo lo que antes era implícito: los campos no se serializan salvo que lo pidas, los miembros privados necesitan un contrato personalizado, y `[Serializable]` en sí no significa nada.

   ```csharp
   // .NET 10.0.11, C# 14
   using System.Text.Json;
   using System.Text.Json.Serialization;

   [JsonSourceGenerationOptions(IncludeFields = true)]
   [JsonSerializable(typeof(CartSnapshot))]
   internal partial class CartContext : JsonSerializerContext;

   public sealed class CartSnapshot
   {
       public int Version;                 // a field, so IncludeFields is required
       public string? CouponCode { get; set; }
       public List<int> LineItemIds { get; set; } = [];
   }

   byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, CartContext.Default.CartSnapshot);
   CartSnapshot? back = JsonSerializer.Deserialize(bytes, CartContext.Default.CartSnapshot);
   ```

   Verificación: `dotnet test` está en verde, y una aserción de ida y vuelta compara cada miembro público **y** privado, no solo los que recordaste.

4. **Agrega una ruta de lectura dual en cada límite duradero.** Este es el paso que te permite publicar. `NrbfDecoder.StartsWithPayloadHeader` te dice si los bytes que acabas de leer son NRBF heredado, y en ese caso los decodificas, los vuelves a serializar con el serializador nuevo y los reescribes. Las lecturas migran el corpus de forma perezosa; las escrituras son solo en formato nuevo desde el primer día.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   internal static CartSnapshot Load(string path)
   {
       byte[] raw = File.ReadAllBytes(path);

       if (!NrbfDecoder.StartsWithPayloadHeader(raw))
       {
           return JsonSerializer.Deserialize(raw, CartContext.Default.CartSnapshot)!;
       }

       CartSnapshot upgraded = ReadLegacy(raw);
       File.WriteAllBytes(path, JsonSerializer.SerializeToUtf8Bytes(upgraded, CartContext.Default.CartSnapshot));
       return upgraded;
   }
   ```

   Verificación: una prueba que escribe una muestra NRBF real de producción en un archivo temporal, llama a `Load`, comprueba los valores y luego comprueba que un segundo `Load` ya no toma la rama heredada.

5. **Implementa `ReadLegacy` con `NrbfDecoder`, un tipo a la vez.** `NrbfDecoder` decodifica; nunca instancia tus tipos, nunca carga un ensamblado y nunca hace recursión. La construcción la haces tú, que es exactamente por lo que es seguro sobre entrada no confiable. `ClassRecord` expone los miembros por nombre con accesores tipados, y `TypeNameMatches` compara nombres de tipo ignorando la identidad del ensamblado, así que el reenvío de tipos y los cambios de versión de ensamblado no te rompen nada.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   private static CartSnapshot ReadLegacy(byte[] raw)
   {
       using MemoryStream stream = new(raw);
       ClassRecord root = NrbfDecoder.DecodeClassRecord(stream);

       if (!root.TypeNameMatches(typeof(CartSnapshot)))
       {
           throw new InvalidDataException($"Unexpected payload type '{root.TypeName.AssemblyQualifiedName}'.");
       }

       SZArrayRecord<int> ids = (SZArrayRecord<int>)root.GetArrayRecord(nameof(CartSnapshot.LineItemIds))!;
       if (ids.Length > 10_000)
       {
           throw new InvalidDataException("Line item array exceeds the sane limit.");
       }

       return new CartSnapshot
       {
           Version = root.HasMember(nameof(CartSnapshot.Version)) ? root.GetInt32(nameof(CartSnapshot.Version)) : 1,
           CouponCode = root.GetString(nameof(CartSnapshot.CouponCode)),
           LineItemIds = [.. ids.GetArray()],
       };
   }
   ```

   `HasMember` es la vía de escape para el versionado: un campo que se agregó o se renombró entre el momento en que se escribió el payload y hoy devuelve `false`, no una excepción. La comprobación de longitud antes de `GetArray` no es opcional, porque NRBF hace que a un payload hostil le salga barato prometer dos mil millones de nulos.

   Verificación: una prueba de decodificación por cada tipo heredado contra un payload real almacenado, más una prueba que confirme que un payload de tamaño excesivo o con el tipo equivocado lanza `InvalidDataException` en lugar de reservar memoria.

6. **Si de verdad no puedes cambiar los tipos, usa `DataContractSerializer` en lugar de los pasos 3 a 5.** Es la única opción recomendada que respeta el modelo de programación de `[Serializable]` e `ISerializable`, así que los tipos quedan intactos. La trampa es que los tipos conocidos hay que declararlos por adelantado, incluidos los privados, y algunos tipos comunes (en particular `DateTimeOffset`) no están en la lista permitida por omisión. `PreserveObjectReferences` restaura el comportamiento de identidad de objetos y ciclos que `BinaryFormatter` te daba gratis.

   ```csharp
   // .NET 10.0.11
   using System.Runtime.Serialization;

   DataContractSerializer serializer = new(
       typeof(CartSnapshot),
       new DataContractSerializerSettings
       {
           KnownTypes = [typeof(PercentageCoupon), typeof(FixedAmountCoupon), typeof(DateTimeOffset)],
           PreserveObjectReferences = true,
       });
   ```

   No recurras a `NetDataContractSerializer` porque el nombre se parezca más. Incrusta información de tipos en el payload igual que `BinaryFormatter` y está catalogado como serializador peligroso.

   Verificación: una prueba de ida y vuelta sobre el cierre completo de tipos conocidos, incluido un grafo con un ciclo deliberado, que pasa con `PreserveObjectReferences = true`.

7. **Trata WinForms y WPF por separado.** Desde .NET 9 ambos frameworks usan internamente un subconjunto de NRBF para el portapapeles, arrastrar y soltar y los recursos en tiempo de diseño, pero solo para una lista intrínseca: los primitivos, `string`, `decimal`, `TimeSpan`, `DateTime`, `nint`, `nuint`, `PointF`, `RectangleF`, más `Bitmap` e `ImageListStreamer` en WinForms, y arreglos y listas de esos. Cualquier otra cosa cae de vuelta a `BinaryFormatter` y falla. La solución prescrita para portapapeles y arrastrar y soltar es poner tú mismo un `string` o un `byte[]` en el portapapeles, normalmente JSON, y parsearlo del lado receptor. Para la serialización Designer/ResX de un tipo personalizado, registra un `TypeConverter` para que el diseñador lo use en lugar de caer a `BinaryFormatter`.

   Verificación: un copiar y pegar manual y un arrastrar y soltar entre dos instancias en ejecución de la aplicación para cada formato personalizado, más un viaje de ida y vuelta del diseñador (abrir un formulario, guardar, reabrir) sin `MSB3825` y sin excepción en tiempo de ejecución.

8. **Solo entonces decide sobre el paquete de compatibilidad.** Si una dependencia de terceros llama a `BinaryFormatter` internamente y no puedes esperar a que la arreglen, instala `System.Runtime.Serialization.Formatters` solo en el proyecto de **aplicación**. El paquete no cambia la identidad de tipo de `BinaryFormatter`, así que las bibliotecas del grafo toman la implementación funcional sin necesidad de recompilarse.

   ```xml
   <!-- .NET 10.0.11. Unsupported, and a temporary measure. -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>
   </PropertyGroup>

   <ItemGroup>
     <PackageReference Include="System.Runtime.Serialization.Formatters" Version="10.0.11" />
   </ItemGroup>
   ```

   Para ResX en concreto hay una segunda puerta: pon también el interruptor de AppContext `System.Resources.Extensions.UseBinaryFormatter` en `true`.

   Verificación: la referencia al paquete existe exactamente en un archivo de proyecto, y hay un issue de seguimiento con fecha que nombra la dependencia que obligó a usarlo.

## Verifica la migración

- `grep -rn "BinaryFormatter" --include=*.cs src/` no devuelve nada fuera de la ruta de decodificación heredada y sus pruebas.
- `dotnet build -warnaserror` está limpio, sin `SYSLIB0011` ni `MSB3825`.
- `dotnet test -c Release` está en verde e incluye al menos una prueba de decodificación por cada tipo heredado contra una muestra real de payload de producción.
- Una ejecución en staging lee el corpus de producción: registra el número de payloads que tomaron la rama heredada y confirma que tiende a cero durante la ventana de transición.
- Los logs no muestran ninguna `PlatformNotSupportedException` de primera oportunidad.
- Si la aplicación es WinForms o WPF, el portapapeles y arrastrar y soltar se probaron entre dos procesos, no solo dentro de uno.

## Reversión

El cambio de código es reversible; el cambio de datos no. Una vez que el paso 4 reescribe un blob en el formato nuevo, los bytes viejos desaparecieron, así que una reversión a una compilación que solo entiende NRBF no los puede leer. Dos consecuencias que conviene planificar: guarda los bytes del formato anterior durante toda tu ventana de reversión (escribe el payload actualizado en una columna o clave nueva en lugar de sobrescribir en el sitio, y elimina el viejo solo cuando la ventana se cierre), y mantén la ruta de lectura heredada con `NrbfDecoder` en el código al menos una versión después de que el contador de migración llegue a cero. Si despliegas con el paquete de compatibilidad como puente, la reversión es trivial pero la exposición de seguridad es real durante todo el tiempo que esté desplegado, así que ponle fecha al issue de seguimiento.

## Trampas que conviene conocer antes de empezar

**`[Serializable]` no significa nada para `System.Text.Json`.** Los tipos que hacían el viaje de ida y vuelta con `BinaryFormatter` con campos privados y sin constructor público producirán en silencio `{}` bajo JSON. El fallo no es una excepción, es salida vacía, y por eso la prueba de ida y vuelta del paso 3 tiene que comparar el estado privado.

**La identidad de objetos desaparece.** `BinaryFormatter` preservaba referencias y manejaba ciclos. `System.Text.Json` necesita `ReferenceHandler.Preserve`, `DataContractSerializer` necesita `PreserveObjectReferences = true`, y si te saltas ambos, un objeto hijo compartido se convierte en silencio en dos objetos tras el viaje de ida y vuelta. Donde el código viejo dependía de la igualdad por referencia después de deserializar, esa suposición ya es incorrecta.

**`NrbfDecoder` es un decodificador, no un emulador de `BinaryFormatter`.** Su comportamiento deliberadamente no coincide con el de `BinaryFormatter`, así que no puedes usar una decodificación exitosa como prueba de que una llamada a `BinaryFormatter` habría sido segura. Tampoco soporta arreglos con índice inicial distinto de cero, que .NET Framework sí podía escribir en payloads NRBF pero .NET nunca leyó.

**Algunas bibliotecas no se pueden migrar en absoluto.** `SettingsPropertyValue.PropertyValue` es de tipo `object`, así que un archivo de configuración de `System.Configuration` podía contener literalmente cualquier cosa. No hay un conjunto cerrado de tipos contra el cual decodificar, lo que significa que no existe ruta con `NrbfDecoder` sin romper la API. Los tipos así son la razón por la que el inventario del paso 1 va primero.

**La serialización de excepciones es una obsolescencia aparte.** `SYSLIB0051` cubre el constructor `Exception(SerializationInfo, StreamingContext)` y el resto del soporte de serialización heredado. Tus excepciones personalizadas probablemente todavía cargan ese constructor; eliminarlo es seguro una vez que nada haga viajes de ida y vuelta de excepciones a través de un formateador, y es un buen `grep` para correr en la misma pasada.

**La conversión entre versiones tiene que correr en algún sitio que todavía tenga una implementación.** Si además estás dejando atrás .NET Framework, escribe la herramienta de conversión de blobs de una sola pasada mientras todavía tengas un runtime con un `BinaryFormatter` funcional, o usa `System.Formats.Nrbf`, que apunta a .NET Standard 2.0 y a .NET Framework precisamente para que el lado de la decodificación pueda correr en cualquier parte.

## Relacionados

- El paso de BinaryFormatter vive dentro del salto más grande de [la lista de verificación de actualización de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), y suele ser la línea más cara de [mover un código de .NET Framework 4.8 a .NET 11](/es/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/).
- Si JSON es tu reemplazo, las jerarquías de tipos `[Serializable]` que BinaryFormatter manejaba de forma implícita necesitan [anotaciones explícitas de `JsonDerivedType`](/es/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), y las formas incómodas suelen terminar en [un `JsonConverter` personalizado](/es/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- Los equipos que hagan esto al mismo tiempo que una limpieza de Newtonsoft deberían leer primero [la migración de Newtonsoft a System.Text.Json en un código grande](/es/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/), porque las dos pasadas tocan los mismos archivos.
- Las compilaciones recortadas y AOT chocan con un muro adyacente: mira [reflection-based serialization has been disabled for this application](/es/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) y el triage más amplio de [PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Fuentes

- [BinaryFormatter migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/), Microsoft Learn
- [Breaking change: In-box BinaryFormatter implementation removed and always throws](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal), Microsoft Learn
- [Read BinaryFormatter (NRBF) payloads](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/read-nrbf-payloads), Microsoft Learn
- [Choose a serializer](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer), Microsoft Learn
- [WinForms and WPF OLE guidance](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/winforms-wpf-ole-guidance), Microsoft Learn
- [BinaryFormatter removal from .NET 9 is complete](https://github.com/dotnet/announcements/issues/317), dotnet/announcements
- [BinaryFormatter obsoletion plan](https://github.com/dotnet/designs/blob/main/accepted/2020/better-obsoletion/binaryformatter-obsoletion.md), dotnet/designs
- [MS-NRBF: .NET Remoting Binary Format specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nrbf/)
