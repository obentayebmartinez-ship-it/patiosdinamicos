# Patios Dinámicos · La Rioja

Plataforma de dos capas para que centros educativos de La Rioja implementen y
monitoricen **patios dinámicos** (recreos organizados por zonas temáticas), y para
que el equipo de orientación regional estudie el impacto agregado en convivencia
y bienestar.

**Estado actual (MVP completo sin backend):** todos los módulos funcionan en
[index.html](index.html) (archivo autónomo sin build) con persistencia en
localStorage. Solo el panel regional usa datos ficticios de demostración.

## Cómo ejecutarlo

Aplicación estática sin build. Las librerías (Leaflet, Leaflet.draw, leaflet-rotate,
turf.js) y las fuentes van incluidas en `lib/` — **la app funciona sin internet**;
solo el fondo del mapa (ortofoto PNOA del IGN, Catastro por WMS, sin API key) y las
búsquedas necesitan conexión.

- Servidor estático: `python -m http.server 8123` (o `npx http-server -p 8123 .`).
- Doble clic en `index.html` también funciona (sin service worker).

Es una **PWA**: servida por https (o localhost) se puede "instalar" en el móvil
(menú del navegador → *Añadir a pantalla de inicio*) y abre a pantalla completa,
incluso sin cobertura en el patio.

**⚠️ Al publicar cualquier cambio** en `index.html` o `lib/`, subir el número de
`VERSION` en [sw.js](sw.js) — si no, los dispositivos con la app instalada pueden
tardar en ver la versión nueva.

## Despliegue estático (sin backend)

No hay build: basta con servir la carpeta. Flujo recomendado (igual que otros
proyectos del equipo, git → Vercel):

1. Repo git en esta carpeta (`git init` ya hecho) y subir a GitHub.
2. En [vercel.com](https://vercel.com) → *Add New Project* → importar el repo.
   Framework *Other*, sin comando de build, directorio de salida `./`.
3. Cada `git push` redespliega. GitHub Pages también sirve (Settings → Pages →
   rama main, carpeta raíz).

Cada dispositivo guarda sus propios datos (localStorage). Para mover datos entre
dispositivos: **Guardar y compartir → Descargar copia completa / Restaurar copia**.

## Módulo 1: editor de patio

- Búsqueda con autocompletado sobre el directorio real de centros escolares de
  La Rioja (OpenStreetMap/Overpass, cacheado 30 días) + Nominatim para
  direcciones, y geolocalización. Capa opcional de parcelas del Catastro para
  trazar el perímetro cuando el arbolado tapa el patio.
- Dibujo del perímetro del patio y de zonas temáticas (deportiva, lectura y calma,
  juegos cognitivos, creativa, otra) sobre vista satélite.
- Validación con turf.js: contención de cada zona en el perímetro (tolerancia 1 %),
  aviso de solapes entre zonas (umbral 1 m²), área en m²/ha.
- "Dividir en N sectores": corta el perímetro en franjas de área similar
  (búsqueda binaria sobre la longitud) como punto de partida editable.
- Guardado en localStorage, exportación/importación de GeoJSON, vista de solo
  lectura "hoy" imprimible con la actividad de cada zona.

## Capa de datos y migración a Supabase

Toda la persistencia pasa por el objeto `DataLayer` en `index.html`
(buscar `CAPA DE DATOS`). Para migrar: sustituir el cuerpo de sus funciones por
llamadas a supabase-js **manteniendo las firmas async**; la UI no cambia.

### Esquema (Postgres + PostGIS, extensión `postgis` activada en Supabase)

```sql
create extension if not exists postgis;

create table centros (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  direccion text,
  tipo text check (tipo in ('colegio','instituto')),
  created_at timestamptz default now()
);

create table patios (
  id uuid primary key default gen_random_uuid(),
  centro_id uuid references centros not null,
  perimetro geometry(Polygon, 4326) not null
);

create table zonas (
  id uuid primary key default gen_random_uuid(),
  patio_id uuid references patios not null,
  nombre text not null,
  tipo text check (tipo in ('deportiva','lectura','cognitiva','creativa','otra')),
  geometria geometry(Polygon, 4326) not null,
  color text,
  capacidad_estimada int
);

create table rotaciones (
  id uuid primary key default gen_random_uuid(),
  patio_id uuid references patios not null,
  fecha date not null,
  zona_id uuid references zonas not null,
  grupo_curso text not null,   -- agregado, ej. "3-4EP"
  actividad text not null,
  responsable text             -- profe voluntario que supervisa (nombre de pila/iniciales)
);

create table incidencias (
  id uuid primary key default gen_random_uuid(),
  centro_id uuid references centros not null,
  zona_id uuid references zonas,
  fecha date not null,
  franja_horaria text,
  curso text not null,         -- agregado, NUNCA alumno individual
  tipo text check (tipo in ('conflicto','exclusion','otro')),
  gravedad smallint check (gravedad between 1 and 3),
  notas_breves text
);

create table encuestas_bienestar (
  id uuid primary key default gen_random_uuid(),
  centro_id uuid references centros not null,
  fecha date not null,
  curso text not null,
  tipo_respondente text check (tipo_respondente in ('alumnado','profesorado')),
  puntuacion smallint check (puntuacion between 1 and 5),
  comentario_opcional text
);
```

Conversión GeoJSON ↔ PostGIS: `ST_GeomFromGeoJSON(...)` al guardar,
`ST_AsGeoJSON(...)` al leer. Áreas/contención nativas: `ST_Area(geography)`,
`ST_Contains`, `ST_Intersects`.

### Cuentas y roles

Dos niveles de cuenta (la UI ya los simula con el selector de perfil; con Supabase
se sustituye por auth real):

```sql
create table usuarios (
  id uuid primary key references auth.users,
  centro_id uuid references centros,          -- null para el rol admin
  rol text not null check (rol in ('centro','admin'))
);
```

- **centro**: cuenta propia de cada centro; ve y edita solo sus patios, rotaciones,
  incidencias, recuentos y encuestas.
- **admin** (orientación regional): lectura de **todos** los patios y zonas
  (vista "Centros y patios") y acceso al panel de investigación.

### RLS (Row Level Security)

- Cada centro solo ve/edita sus propias filas (`centro_id` del usuario vía tabla
  `usuarios`).
- El rol admin tiene `select` sobre patios/zonas/rotaciones de todos los centros
  (solo lectura), y para investigación **solo** accede a vistas agregadas
  (por zona/franja/curso, mínimo k centros o k registros por celda), nunca a las
  tablas base con detalle salvo consentimiento institucional explícito.

## Protección de datos (decisión de diseño, no negociable)

- Ningún formulario registra datos identificables de alumnado individual; la
  granularidad mínima es curso/grupo.
- Todos los datos mock son ficticios (CEIP Valdemontes, IES Cierzo Alto,
  CRA Los Sotos — no existen).
- Al nivel regional solo suben agregados anonimizados.

## Hoja de ruta

1. ✅ **Fase 1:** editor de patio con mapa (este entregable).
2. ✅ **Rotación semanal:** editor grupos × días × zonas con generación
   automática round-robin; alimenta la vista de hoy y el cartel imprimible.
3. ✅ **Registro rápido de incidencias:** formulario móvil de 4 toques
   (zona en mini-plano táctil, tipo, curso agregado, gravedad + nota opcional),
   lista del día con borrado, layout responsive (nav horizontal en <700px).
4. ✅ **Encuestas de bienestar:** cuestionario anónimo con escala de pictogramas
   (alumnado, 5 ítems + curso agregado) y de acuerdo (profesorado, 6 ítems),
   con resumen del trimestre en vivo.
5. ✅ **Panel del centro:** KPIs (incidencias hoy / 7 días con delta, bienestar
   por colectivo del trimestre) y gráficos con los datos reales — incidencias por
   zona, por día (14 días), por tipo y gravedad; cada gráfico con vista de tabla.
6. ✅ **Panel regional (demo):** 3 centros ficticios con series inventadas —
   comparativa anonimizada por defecto (toggle de nombres), series temporales de
   incidencias/100 alumnos y participación, bienestar por trimestre, filtros
   etapa/ruralidad/tamaño (los colores siguen al centro, no al filtro),
   exportación CSV real; PDF queda para fase 2.
7. ✅ **Recuento rápido de ocupación:** un toque por zona (vacía/poca/media/llena)
   durante la guardia; KPI y gráfico de ocupación media por zona en el panel.
8. ✅ **Pulido piloto:** franja horaria en incidencias (preseleccionada por hora),
   buscador de centros con directorio real, capa Catastro, informe regional
   imprimible (guardar como PDF), multi-patio con copia completa para traspaso
   entre dispositivos.
9. ✅ **Robustez pre-Supabase:** PWA instalable y offline (librerías y fuentes en
   `lib/`, service worker), autoguardado del patio y de la rotación (sin botones
   de guardar), borrados en dos toques con "Deshacer" en registros, historial de
   incidencias navegable por fecha, cruce ocupación × incidencias por zona con
   lectura automática, medias por pregunta de las encuestas, exportación CSV del
   panel del centro, ids únicos, escapado de textos libres.
10. ✅ **Pase de encuestas por kiosco y papel:** modo kiosco a pantalla completa
    (el dispositivo pasa de mano en mano; contador visible; cerrar requiere
    pulsación mantenida) y formulario de papel imprimible con volcado de
    recuentos por carita (se convierten en filas individuales con medias
    exactas, marcadas `metodo:'papel'`). Anti dobles envíos: cada pase queda
    registrado como **sesión por curso y trimestre** (la encuesta es anónima,
    así que el control es por curso, no por persona); al repetir curso la app
    avisa y pide confirmación.
11. Fase 2 (final): Supabase — auth por centro, PostGIS, RLS, vistas agregadas
   para el rol investigador; sustituir datos demo del panel regional y sincronizar
   dispositivos sin copia manual.
