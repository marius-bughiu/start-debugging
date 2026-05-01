---
title: "C# 14: la palabra clave field y las propiedades respaldadas por field"
description: "C# 14 introduce la palabra clave contextual field en los accesores de propiedades, lo que te permite añadir lógica personalizada a las auto-properties sin declarar un campo de respaldo aparte."
pubDate: 2025-04-05
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2025/04/c-14-the-field-keyword-and-field-backed-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 14 introduce una nueva palabra clave contextual, **`field`**, que se puede usar dentro de los accesores de una propiedad (los bloques `get`, `set` o `init`) para referirse al almacenamiento de respaldo de la propiedad. En términos sencillos, `field` es un marcador que representa la variable oculta donde se almacena el valor de una propiedad. Esta palabra clave te permite añadir lógica personalizada a las propiedades implementadas automáticamente sin declarar manualmente un campo privado aparte. Apareció primero como vista previa en C# 13 (requería .NET 9 con la versión del lenguaje en preview) y, oficialmente, forma parte del lenguaje en C# 14.

**¿Por qué es útil?** Antes de C# 14, si querías añadir lógica (como validación o notificación de cambios) a una propiedad, tenías que convertirla en una propiedad completa con un campo privado de respaldo. Eso suponía más código repetitivo y el riesgo de que otros miembros de la clase usaran ese campo directamente, saltándose la lógica de la propiedad. La nueva palabra clave `field` aborda estos problemas dejando que el compilador genere y administre el campo de respaldo por ti, mientras tú simplemente usas `field` en el código de tu propiedad. El resultado son declaraciones de propiedad más limpias y mantenibles, evitando que el almacenamiento de respaldo "se filtre" al resto del ámbito de tu clase.

## Beneficios y casos de uso de `field`

La palabra clave `field` se introdujo para hacer las declaraciones de propiedades más concisas y menos propensas a errores. Estos son los principales beneficios y escenarios donde resulta útil:

-   **Eliminar campos de respaldo manuales:** Ya no necesitas escribir un campo privado para cada propiedad solo para añadir comportamiento personalizado. El compilador proporciona automáticamente un campo de respaldo oculto, accesible mediante la palabra clave `field`. Esto reduce el código repetitivo y mantiene la definición de la clase más limpia.
-   **Mantener encapsulado el estado de la propiedad:** El campo de respaldo creado por el compilador solo es accesible a través de los accesores de la propiedad (vía `field`), no en otras partes de tu clase. Esto evita el uso accidental del campo desde otros métodos o propiedades, asegurando que cualquier invariante o validación en el accesor de la propiedad no pueda ser saltada.
-   **Lógica de propiedad más fácil (validación, inicialización perezosa, etc.):** Ofrece un camino sencillo para añadir lógica a las auto-properties. Escenarios comunes incluyen:
    
    -   _Validación o comprobación de rango:_ por ejemplo, asegurar que un valor sea no negativo o esté dentro de un rango antes de aceptarlo.
    -   _Notificación de cambios:_ por ejemplo, lanzar eventos `INotifyPropertyChanged` después de asignar un nuevo valor.
    -   _Inicialización perezosa o por defecto:_ por ejemplo, en un getter, inicializar `field` en el primer acceso o devolver un valor por defecto si no está establecido.


    En versiones anteriores de C#, estos escenarios requerían escribir una propiedad completa con un campo aparte. Con `field`, puedes implementarlos directamente en la lógica de `get`/`set` de la propiedad sin campos extra.
-   **Mezclar accesores automáticos y personalizados:** C# 14 permite que un accesor sea auto-implementado y el otro tenga un cuerpo que use `field`. Por ejemplo, puedes proporcionar un `set` personalizado y dejar `get` como automático, o al revés. El compilador genera lo necesario para el accesor que no escribes. Esto no era posible antes: añadir un cuerpo a un accesor obligaba a proporcionar una implementación explícita para ambos.

En conjunto, `field` mejora la legibilidad y la mantenibilidad eliminando código redundante y centrando la atención solo en el comportamiento personalizado que necesitas. Es conceptualmente similar a cómo funciona la palabra clave `value` en un setter (representando el valor que se está asignando); aquí `field` representa el almacenamiento subyacente de la propiedad.

## Antes vs. después: campo de respaldo manual vs. la palabra clave `field`

Para ver la diferencia, comparemos cómo declararías una propiedad que aplica una regla **antes** de C# 14 y **después** usando la nueva palabra clave `field`.

**Escenario:** Supón que queremos una propiedad `Hours` que nunca se pueda asignar a un número negativo. En versiones anteriores de C# haríamos lo siguiente:

**Antes de C# 14, usando un campo de respaldo manual:**

```cs
public class TimePeriodBefore
{
    private double _hours;  // backing field

    public double Hours
    {
        get { return _hours; }
        set 
        {
            if (value < 0)
                throw new ArgumentOutOfRangeException(nameof(value), "Value must not be negative");
            _hours = value;
        }
    }
}
```

En este código previo a C# 14, tuvimos que introducir un campo privado `_hours` para guardar el valor. El getter de la propiedad devuelve este campo y el setter realiza una comprobación antes de asignar a `_hours`. Funciona, pero es verboso: hay código extra para declarar y administrar `_hours`, y `_hours` es accesible en cualquier parte de la clase (lo que significa que otros métodos **podrían** escribir en `_hours` y saltarse la lógica de validación si no se tiene cuidado).

**Desde C# 14, usando la palabra clave `field`:**

```cs
public class TimePeriod
{
    public double Hours
    {
        get;  // auto-implemented getter (compiler provides it)
        set => field = (value >= 0) 
            ? value 
            : throw new ArgumentOutOfRangeException(nameof(value), "Value must not be negative");
    }
}
```

Aquí, la propiedad `Hours` se declara sin un campo de respaldo explícito. Usamos `get;` sin cuerpo, indicando un getter automático, y proporcionamos un cuerpo para `set` que usa `field`. La expresión `field = ...` dentro del setter le dice al compilador que asigne al campo de respaldo de la propiedad. El compilador generará automáticamente un campo privado en segundo plano e implementará el accesor `get` para devolver ese campo. En el setter de arriba, si el `value` es negativo, lanzamos una excepción; de lo contrario, lo asignamos a `field` (que lo almacena). **No** tuvimos que declarar `_hours` nosotros mismos, y tampoco hace falta escribir el cuerpo del getter: el compilador hace eso por nosotros. El resultado es una definición de propiedad más concisa con el mismo comportamiento.

Observa lo mucho más limpia que es la versión de C# 14:

-   eliminamos el campo explícito `_hours`; el compilador se encarga de él.
-   el accesor `get` sigue siendo un simple auto-implementado (`get;`), que el compilador convertirá en "devuelve el campo de respaldo".
-   el accesor `set` contiene solo la lógica que nos importa (la comprobación de no negatividad); la asignación de almacenamiento real la maneja `field = value`.

También puedes usar `field` en un accesor `get` si lo necesitas. Por ejemplo, para implementar una inicialización perezosa, podrías hacer algo como:

```cs
public string Name 
{
    get => field ??= "Unknown";
    set => field = value;
}
```

En este caso, la primera vez que se accede a `Name`, si no se había asignado, el getter asigna un valor por defecto `"Unknown"` al campo de respaldo y lo devuelve. Las siguientes lecturas o cualquier asignación usarán el mismo `field`. Sin esta característica, habrías necesitado un campo privado y más código en el getter para conseguir el mismo comportamiento.

## Cómo maneja el compilador la palabra clave `field`

Cuando usas `field` dentro de un accesor de propiedad, el compilador genera silenciosamente un campo de respaldo oculto para esa propiedad (muy parecido a cómo lo hace para una propiedad auto-implementada). Nunca verás este campo en tu código fuente, pero el compilador le da un nombre interno (por ejemplo, algo como `<Hours>k__BackingField`) y lo usa para almacenar el valor de la propiedad. Esto es lo que ocurre por debajo:

-   **Generación del campo de respaldo:** Si al menos un accesor de una propiedad usa `field` (o si tienes una propiedad auto-implementada sin cuerpos), el compilador crea un campo privado para guardar el valor. No necesitas declarar este campo. En el ejemplo de `TimePeriod.Hours` de arriba, el compilador generaría un campo para almacenar el valor de las horas, y los accesores `get` y `set` operarán sobre ese campo (de forma implícita o vía la palabra clave `field`).
-   **Implementación de getter/setter:**
    -   Para un accesor auto-implementado (como `get;` o `set;` sin cuerpo), el compilador genera automáticamente la lógica simple para devolver o asignar el campo de respaldo.
    -   Para un accesor en el que proporcionaste un cuerpo usando `field`, el compilador inserta tu lógica y trata `field` como una referencia al campo de respaldo en ese código generado. Por ejemplo, `set => field = value;` se vuelve algo similar a `set { backingField = value; }` en la salida compilada, conservando alrededor cualquier lógica adicional que escribiste.
    -   Puedes mezclar accesores automáticos y personalizados. Por ejemplo, si escribes un cuerpo para `set` (usando `field`) y dejas `get` como `get;`, el compilador genera el `get` por ti. A la inversa, podrías escribir un `get` personalizado (por ejemplo, `get => ComputeSomething(field)`) y tener un `set;` auto-implementado, en cuyo caso el compilador genera el setter para simplemente asignar al campo de respaldo.
-   **El comportamiento es equivalente al de los campos manuales:** El resultado compilado al usar `field` es esencialmente el mismo que si hubieras escrito manualmente un campo privado y lo hubieras usado en tu propiedad. No hay penalización de rendimiento ni magia más allá de ahorrarte el código repetitivo. Es puramente una característica de comodidad en tiempo de compilación. Por ejemplo, las dos implementaciones de `Hours` de arriba (con y sin `field`) compilan a un código IL muy similar: ambas tienen un campo privado para almacenar el valor y accesores de propiedad que manipulan ese campo. La diferencia es que el compilador de C# 14 escribió uno de ellos por ti.
-   **Inicializadores de propiedad:** Si usas un inicializador en una propiedad que utiliza `field` (por ejemplo, `public int X { get; set => field = value; } = 42;`), el inicializador inicializará directamente el campo de respaldo _antes_ de que se ejecute el constructor, igual que ocurre con las auto-properties tradicionales. **No** invocará la lógica del setter durante la construcción del objeto. (Esto es importante de tener en cuenta si tu setter tiene efectos secundarios; estos no ocurrirán con el valor inicial asignado mediante un inicializador. Si necesitas que la lógica del setter se ejecute para la inicialización, asigna la propiedad en el constructor en lugar de usar un inicializador.)
-   **Atributos en el campo de respaldo:** Si necesitas aplicar atributos al campo de respaldo generado, C# permite _atributos dirigidos al campo_ usando la sintaxis `[field: ...]`. Esto ya era posible con auto-properties y aquí también funciona. Por ejemplo, puedes hacer `[field: NonSerialized] public int Id { get; set => field = value; }` para marcar el campo autogenerado como no serializable. (Esto solo funciona si realmente existe un campo de respaldo para la propiedad, es decir, tienes al menos un accesor que usa `field` o una propiedad auto.)

TLDR; el compilador genera un campo de respaldo privado y conecta tus accesores de propiedad para usarlo. Obtienes la funcionalidad de una propiedad completa con una fracción del código. La propiedad sigue siendo, desde el punto de vista de implementación, una auto-propiedad real; simplemente conseguiste un gancho para inyectar lógica.

## Reglas de sintaxis y uso de `field`

Al usar la palabra clave `field`, ten en cuenta las siguientes reglas y limitaciones:

-   **Solo dentro de accesores de propiedad/indexador:** `field` **solo** puede usarse dentro del cuerpo de un accesor de propiedad o indexador (el bloque de código o expresión para `get`, `set` o `init`). Es una palabra clave _contextual_, lo que significa que fuera del accesor de una propiedad, `field` no tiene un significado especial (sería tratada simplemente como un identificador). Si intentas usar `field` en un método regular o fuera de una propiedad, obtendrás un error de compilación: el compilador no sabrá a qué campo de respaldo te refieres.
-   **Palabra clave contextual (no totalmente reservada):** Dado que `field` no es una palabra clave reservada globalmente, técnicamente podrías tener variables o miembros llamados `field` en otras partes de tu código. Sin embargo, dentro del accesor de una propiedad, `field` se trata como palabra clave y se referirá al campo de respaldo, no a ninguna variable llamada `field`. Consulta "conflictos de nombres" más abajo para saber cómo tratar ese escenario.
-   **Uso en accesores get/set/init:** Puedes usar `field` dentro de un accesor `get`, `set` o `init`. En un setter o accesor init, normalmente se asigna a `field` (por ejemplo, `field = value;`). En un getter, podrías devolver o modificar `field` (por ejemplo, `return field;` o `field ??= defaultValue;`). Puedes usar `field` en un solo accesor o en ambos, según tus necesidades:
    -   Si usas `field` en **un único accesor**, puedes dejar el otro como auto-implementado (`get;` o `set;` sin cuerpo) y el compilador igualmente creará el campo de respaldo y conectará todo.
    -   Si usas `field` en **ambos** accesores, también está bien: estás escribiendo la lógica completa de get y set (pero sin declarar manualmente el campo). Esto puede hacerse si tanto la lectura como la escritura necesitan tratamiento especial. Por ejemplo, un setter podría imponer una condición y un getter podría hacer alguna transformación o carga perezosa en el primer acceso, ambos utilizando el mismo `field`.
-   **No puedes referirte a `field` fuera del accesor:** No puedes almacenar la referencia `field` para usarla en otro lugar, ni acceder directamente al campo de respaldo generado por el compilador fuera de la propiedad. A todos los efectos, ese campo de respaldo es anónimo en tu código fuente (aunque el compilador le dé un nombre interno). Si necesitas interactuar con el valor, hazlo a través de la propiedad o dentro de sus accesores usando `field`.
-   **No para eventos:** La palabra clave `field` está diseñada para propiedades (e indexadores). **No** está disponible para los accesores add/remove de eventos. (Los eventos en C# también pueden tener campos de respaldo para el delegado, pero el equipo del lenguaje decidió no extender `field` a los accesores de eventos.)
-   **No mezclar con declaraciones de campo explícitas:** Si decides declarar tu propio campo de respaldo para una propiedad, no deberías usar `field` en los accesores de esa propiedad. En tal caso, simplemente referenciarías tu campo explícito por nombre como tradicionalmente. La palabra clave `field` está pensada para reemplazar la necesidad de un campo explícito en esos escenarios. En otras palabras, una propiedad o tiene un campo implícito gestionado por el compilador (cuando usas `field` o accesores automáticos), o lo gestionas tú; no ambos.

Dicho de forma simple: usa `field` dentro de los accesores de tu propiedad para referirte al almacenamiento oculto de esa propiedad, y no en ningún otro sitio. Sigue las reglas normales de ámbito de C# para todo lo que esté fuera de las propiedades.

## Manejo de conflictos de nombres (cuando tienes tu propia variable `field`)

Como `field` no era una palabra reservada en versiones anteriores de C#, es posible (aunque poco habitual) que algún código haya usado "field" como nombre de variable o de campo. Con la introducción de la palabra clave contextual `field` en los accesores, ese código podría volverse ambiguo o romperse. El diseño del lenguaje lo tiene en cuenta:

-   **`field` en un accesor sombrea a otros identificadores:** Dentro de los accesores de propiedad, la nueva palabra clave `field` **sombreará** a cualquier identificador llamado `field` que pudieras tener en ese ámbito. Por ejemplo, si tenías una variable local o un parámetro llamado `field` dentro de un setter (quizá de código antiguo), el compilador ahora interpretará `field` como la palabra clave del campo de respaldo, no como tu variable. En C# 14, esto resulta en un error de compilación si intentas declarar o usar una variable llamada `field` en un accesor, porque ahora se espera que `field` sea la palabra clave.
-   **Usar `@field` o `this.field` para referirse al campo real:** Si _de hecho_ tienes un campo miembro literalmente llamado "field" en tu clase (no recomendado, pero posible), o una variable en ámbito llamada "field", aún puedes referenciarla escapando el nombre. C# permite anteponer `@` a un identificador para usarlo aunque sea una palabra clave. Por ejemplo, si tu clase tiene `private int field;` y necesitas referenciarlo en un accesor, puedes escribir `@field` para acceder a él como identificador. De forma similar, podrías usar `this.field` para referirte explícitamente al campo miembro. Usar `@` o un calificador esquiva la interpretación de palabra clave contextual y te permite acceder a la variable real.

```cs
private int field = 10; // a field unfortunately named "field" 
public int Example
{
    get { return @field; } // use @field to return the actual field 
    set { @field = value; } // or this.field = value; either works 
}
```

-   No obstante, si está en tu mano, lo mejor es renombrar el miembro para evitar confusiones. En C# moderno, `field` por sí solo en un accesor debería estar reservado al campo de respaldo del compilador. De hecho, si actualizas una base de código antigua a C# 14, el compilador te avisará si encuentra usos de `field` que antes hubieran hecho referencia a otra cosa, indicando que deberías desambiguarlos.
-   **Evitar el nombre del todo:** Como buena práctica general, intenta no usar `field` como nombre de identificador en tu código. Ahora que es palabra clave (en contexto), tratarlo como un nombre normal confundirá a los lectores y puede provocar errores. Si venías usando `field` como nombre de variable, considera renombrarla al pasar a C# 14. Las convenciones de nombres habituales (como prefijar los campos privados con `_` o similares) evitarían naturalmente este conflicto en la mayoría de los casos.

## Referencias

1.  [`field` – Field backed property declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field#:~:text=The%20,contextual%20keyword)​
2.  ​[C# Feature Proposal Notes – _"`field` keyword in properties"_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/field-keyword#:~:text=Auto%20properties%20only%20allow%20for,accessors%20from%20within%20the%20class)
3.  ​[What's new in C# 14](/2024/12/csharp-14/)
