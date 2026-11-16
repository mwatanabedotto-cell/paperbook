# Paperbook

Visor de documentos para tablet y computadora: guarda PDF, páginas web e imágenes, escribe encima
como en un lienzo y sincroniza todo con tu Google Drive. Es una aplicación web instalable (PWA),
sin servidor propio y sin paso de compilación.

## Qué hace

- **Biblioteca**: PDF, imágenes, páginas web guardadas y lienzos en blanco. Búsqueda, filtros por tipo y carpetas.
- **Búsqueda**: el buscador de la biblioteca encuentra palabras dentro de los PDF y páginas web (sin
  distinguir acentos ni mayúsculas) y abre el documento en la primera coincidencia. Dentro del visor,
  la lupa o Ctrl+F resalta y recorre los resultados. Los PDF escaneados (solo imagen) no tienen texto que buscar.
- **Lienzo sobre cualquier documento**: bolígrafo (sensible a la presión del lápiz), resaltador, borrador,
  línea, flecha, rectángulo, elipse y texto. Colores, grosor, deshacer/rehacer y zoom.
- **Lienzos en blanco**: papel liso, rayado, cuadriculado o de puntos; páginas ilimitadas.
- **Lápiz y dedo**: al detectar un lápiz, el lápiz dibuja y el dedo desplaza. Con el dedo dibujando,
  dos dedos mueven y hacen zoom. Se cambia en el menú «⋯» del visor.
- **Sin conexión**: los documentos se guardan en el dispositivo (IndexedDB) y la app funciona offline.
- **Google Drive**: documentos y anotaciones se guardan en la carpeta «Paperbook» de tu Drive. Las
  anotaciones hechas en dos dispositivos a la vez se fusionan trazo a trazo, sin perder ninguna.
- **Recuerda** la última página leída de cada documento.
- **Exporta** una página con sus anotaciones como imagen PNG.

## Publicarla (GitHub Pages)

Google solo permite iniciar sesión desde una dirección `https://`, así que la app debe estar publicada:

1. En GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**.
2. Elige la rama que contiene estos archivos y la carpeta `/ (root)`. Guarda.
3. En un par de minutos estará en `https://mwatanabedotto-cell.github.io/paperbook/`.
   (En repositorios privados, Pages requiere un plan de pago de GitHub.)
4. En la tablet o computadora, abre esa dirección y usa «Instalar aplicación» / «Añadir a pantalla de inicio».

Para probarla en local: `python3 -m http.server 8000` y abre `http://localhost:8000`.

## Sincronizar con Google Drive

La app habla directamente con tu Drive, sin servidor intermedio. Para eso Google exige un
«ID de cliente OAuth» propio, que se crea gratis una sola vez:

1. Entra en <https://console.cloud.google.com/> y crea un proyecto (por ejemplo «Paperbook»).
2. **APIs y servicios → Biblioteca**: busca **Google Drive API** y pulsa **Habilitar**.
3. **APIs y servicios → Pantalla de consentimiento de OAuth** (o «Google Auth Platform»): tipo **Externo**,
   pon un nombre y tu correo. En **Usuarios de prueba**, añade tu propia cuenta de Google.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**.
   En **Orígenes autorizados de JavaScript** añade `https://mwatanabedotto-cell.github.io`
   (y `http://localhost:8000` si la usas en local).
5. Copia el **ID de cliente** (termina en `.apps.googleusercontent.com`).
6. En Paperbook pulsa **Conectar Drive**, pega el ID y pulsa **Conectar con Google**.
   Repite este último paso en cada dispositivo, con el mismo ID.

La app pide el permiso mínimo (`drive.file`): solo puede ver los archivos que ella misma crea, no el
resto de tu Drive. Por eso los PDF que ya tienes en Drive hay que añadirlos desde la app
(«Añadir → Subir archivos»).

En Drive, cada documento son dos archivos: el original (`.pdf`, `.html`, imagen) y un
`.paperbook.json` con el título, la carpeta y las anotaciones.

## Guardar páginas web

«Añadir → Guardar página web» descarga la página, le quita los scripts e incrusta imágenes y estilos
para leerla sin conexión. Limitaciones:

- Los navegadores impiden descargar páginas de otros sitios, así que cuando la descarga directa falla
  se usa un proxy público (`api.allorigins.win` por defecto, configurable o desactivable en el diálogo
  de Drive/ajustes). Ese proxy ve la dirección de la página que guardas.
- Las páginas que requieren iniciar sesión o que se construyen con JavaScript no se capturan bien.
  Alternativa fiable: en el navegador, «Imprimir → Guardar como PDF», y sube el PDF.
- En Android, con la app instalada, puedes usar «Compartir → Paperbook» desde el navegador.

## Estructura

```
index.html, css/app.css     interfaz
js/app.js                   biblioteca, importación, navegación
js/viewer.js                visor y herramientas de dibujo
js/ink.js                   motor de tinta (dibujo y borrado de trazos)
js/store.js                 almacenamiento local y fusión de anotaciones
js/drive.js                 sincronización con Google Drive
js/web.js                   captura de páginas web
js/search.js                índice de texto para la búsqueda
sw.js                       funcionamiento sin conexión
vendor/pdfjs/               PDF.js 4.10 (Mozilla, licencia Apache 2.0)
```
