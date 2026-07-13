-- ============================================================
-- Patios Dinámicos · La Rioja — esquema de Supabase (Postgres)
-- Pegar TODO este archivo en el SQL Editor de Supabase y ejecutar.
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- Diseño: la app sigue trabajando contra localStorage (funciona
-- offline en el patio); estas tablas son la réplica sincronizada.
-- Los ids de patios y registros los genera el cliente (texto corto
-- con azar), por eso las claves primarias son (centro_id, id).
-- Granularidad mínima de datos: curso/grupo — NUNCA alumno (RGPD).
-- ============================================================

-- ------------------------------------------------------------
-- Tablas
-- ------------------------------------------------------------

create table if not exists centros (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  tipo        text check (tipo in ('colegio','instituto')),
  etapa       text check (etapa in ('EI','EP','ESO','mixta')),
  ruralidad   text check (ruralidad in ('urbano','rural')),
  num_alumnos int,
  creado      timestamptz not null default now()
);

-- Cada usuario de Authentication se liga aquí a un centro y un rol.
-- rol 'centro': ve y edita solo lo de su centro.
-- rol 'admin' (orientación regional): lectura de todos los centros.
create table if not exists usuarios (
  id        uuid primary key references auth.users on delete cascade,
  centro_id uuid references centros on delete set null,  -- null para admin
  rol       text not null default 'centro' check (rol in ('centro','admin'))
);

-- Un centro puede tener varios patios. geojson = FeatureCollection
-- completo del editor (perímetro + zonas con sus propiedades);
-- rotacion = documento semanal {grupos, responsables, dias[5]}.
create table if not exists patios (
  centro_id   uuid not null references centros on delete cascade,
  id          text not null,
  nombre      text not null,
  geojson     jsonb,
  rotacion    jsonb,
  actualizado timestamptz not null default now(),
  primary key (centro_id, id)
);

create table if not exists incidencias (
  centro_id   uuid not null references centros on delete cascade,
  id          text not null,
  patio_id    text not null,
  fecha       date not null,
  hora        text,
  zona_id     text,               -- null = "otro lugar"
  zona_nombre text,
  tipo        text check (tipo in ('conflicto','exclusion','otro')),
  curso       text not null,      -- agregado, NUNCA alumno individual
  gravedad    smallint check (gravedad between 1 and 3),
  franja      text,
  nota        text,
  creado      timestamptz not null default now(),
  primary key (centro_id, id)
);

-- Recuento rápido de ocupación: niveles = {zonaId: 0-3}
create table if not exists ocupaciones (
  centro_id uuid not null references centros on delete cascade,
  id        text not null,
  patio_id  text not null,
  fecha     date not null,
  hora      text,
  niveles   jsonb not null,
  creado    timestamptz not null default now(),
  primary key (centro_id, id)
);

-- Encuestas de bienestar (anónimas; el volcado de papel genera
-- también filas individuales con metodo='papel').
create table if not exists encuestas (
  centro_id        uuid not null references centros on delete cascade,
  id               text not null,
  patio_id         text not null,
  fecha            date not null,
  trimestre        text check (trimestre in ('T1','T2','T3')),
  tipo_respondente text check (tipo_respondente in ('alumnado','profesorado')),
  curso            text not null,
  puntuacion       numeric,
  respuestas       jsonb,
  comentario       text,
  metodo           text,
  creado           timestamptz not null default now(),
  primary key (centro_id, id)
);

-- Sesiones de pase de encuesta (control anti dobles envíos por curso)
create table if not exists sesiones_encuesta (
  centro_id        uuid not null references centros on delete cascade,
  id               text not null,
  patio_id         text not null,
  fecha            date not null,
  trimestre        text,
  tipo_respondente text,
  curso            text,
  metodo           text,
  n                int,
  creado           timestamptz not null default now(),
  primary key (centro_id, id)
);

-- ------------------------------------------------------------
-- Funciones auxiliares para las políticas.
-- SECURITY DEFINER: leen `usuarios` sin pasar por su propio RLS
-- (evita recursión de políticas).
-- ------------------------------------------------------------

create or replace function mi_centro()
returns uuid language sql stable security definer set search_path = public as
$$ select centro_id from usuarios where id = auth.uid() $$;

create or replace function soy_admin()
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select rol = 'admin' from usuarios where id = auth.uid()), false) $$;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------

alter table centros           enable row level security;
alter table usuarios          enable row level security;
alter table patios            enable row level security;
alter table incidencias       enable row level security;
alter table ocupaciones       enable row level security;
alter table encuestas         enable row level security;
alter table sesiones_encuesta enable row level security;

-- usuarios: cada uno lee su propia fila (la app la usa para saber
-- su rol y su centro). Altas/cambios solo desde el panel de Supabase.
drop policy if exists usuarios_leer_mi_fila on usuarios;
create policy usuarios_leer_mi_fila on usuarios
  for select using (id = auth.uid());

-- centros: un centro ve su ficha; el admin las ve todas y las gestiona.
drop policy if exists centros_select on centros;
create policy centros_select on centros
  for select using (soy_admin() or id = mi_centro());
drop policy if exists centros_admin_insert on centros;
create policy centros_admin_insert on centros
  for insert with check (soy_admin());
drop policy if exists centros_admin_update on centros;
create policy centros_admin_update on centros
  for update using (soy_admin()) with check (soy_admin());
-- Un centro puede editar la ficha de SU propio centro (p. ej. el nombre
-- desde la app). No puede cambiar de centro_id porque el filtro es su propio id.
drop policy if exists centros_update_propio on centros;
create policy centros_update_propio on centros
  for update using (id = mi_centro()) with check (id = mi_centro());

-- Tablas de datos: el centro opera solo sobre sus filas;
-- el admin (orientación regional) tiene lectura de todas.
-- (mismas cuatro políticas para las cinco tablas)

drop policy if exists patios_select on patios;
create policy patios_select on patios
  for select using (centro_id = mi_centro() or soy_admin());
drop policy if exists patios_insert on patios;
create policy patios_insert on patios
  for insert with check (centro_id = mi_centro());
drop policy if exists patios_update on patios;
create policy patios_update on patios
  for update using (centro_id = mi_centro()) with check (centro_id = mi_centro());
drop policy if exists patios_delete on patios;
create policy patios_delete on patios
  for delete using (centro_id = mi_centro());

drop policy if exists incidencias_select on incidencias;
create policy incidencias_select on incidencias
  for select using (centro_id = mi_centro() or soy_admin());
drop policy if exists incidencias_insert on incidencias;
create policy incidencias_insert on incidencias
  for insert with check (centro_id = mi_centro());
drop policy if exists incidencias_update on incidencias;
create policy incidencias_update on incidencias
  for update using (centro_id = mi_centro()) with check (centro_id = mi_centro());
drop policy if exists incidencias_delete on incidencias;
create policy incidencias_delete on incidencias
  for delete using (centro_id = mi_centro());

drop policy if exists ocupaciones_select on ocupaciones;
create policy ocupaciones_select on ocupaciones
  for select using (centro_id = mi_centro() or soy_admin());
drop policy if exists ocupaciones_insert on ocupaciones;
create policy ocupaciones_insert on ocupaciones
  for insert with check (centro_id = mi_centro());
drop policy if exists ocupaciones_update on ocupaciones;
create policy ocupaciones_update on ocupaciones
  for update using (centro_id = mi_centro()) with check (centro_id = mi_centro());
drop policy if exists ocupaciones_delete on ocupaciones;
create policy ocupaciones_delete on ocupaciones
  for delete using (centro_id = mi_centro());

drop policy if exists encuestas_select on encuestas;
create policy encuestas_select on encuestas
  for select using (centro_id = mi_centro() or soy_admin());
drop policy if exists encuestas_insert on encuestas;
create policy encuestas_insert on encuestas
  for insert with check (centro_id = mi_centro());
drop policy if exists encuestas_update on encuestas;
create policy encuestas_update on encuestas
  for update using (centro_id = mi_centro()) with check (centro_id = mi_centro());
drop policy if exists encuestas_delete on encuestas;
create policy encuestas_delete on encuestas
  for delete using (centro_id = mi_centro());

drop policy if exists sesiones_select on sesiones_encuesta;
create policy sesiones_select on sesiones_encuesta
  for select using (centro_id = mi_centro() or soy_admin());
drop policy if exists sesiones_insert on sesiones_encuesta;
create policy sesiones_insert on sesiones_encuesta
  for insert with check (centro_id = mi_centro());
drop policy if exists sesiones_update on sesiones_encuesta;
create policy sesiones_update on sesiones_encuesta
  for update using (centro_id = mi_centro()) with check (centro_id = mi_centro());
drop policy if exists sesiones_delete on sesiones_encuesta;
create policy sesiones_delete on sesiones_encuesta
  for delete using (centro_id = mi_centro());

-- ============================================================
-- ALTA DE CENTROS Y USUARIOS (hacer a mano, una vez)
-- ============================================================
-- 1. En Authentication → Sign In / Up: DESACTIVAR "Allow new users
--    to sign up" (las cuentas las crea orientación, no hay registro
--    público) y desactivar "Confirm email" si se quiere entrar ya.
-- 2. En Authentication → Users → Add user: crear cada cuenta
--    (email + contraseña) y copiar su UUID.
-- 3. Crear el centro y ligar el usuario (ejemplos):
--
-- insert into centros (nombre, tipo, etapa, ruralidad, num_alumnos)
--   values ('CEIP Ejemplo', 'colegio', 'EP', 'urbano', 450)
--   returning id;
--
-- insert into usuarios (id, centro_id, rol)
--   values ('<uuid-del-usuario>', '<uuid-del-centro>', 'centro');
--
-- -- cuenta del equipo de orientación regional (sin centro):
-- insert into usuarios (id, rol) values ('<uuid-del-usuario>', 'admin');
