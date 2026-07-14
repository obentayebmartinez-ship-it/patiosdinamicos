// ============================================================
// Edge Function: dar-acceso
// Crea la cuenta de un centro DESDE la app (botón "Dar acceso" de la
// vista Solicitudes). Vive en el servidor porque usa la clave maestra
// (service_role), que NUNCA puede estar en el navegador.
//
// Qué hace, en orden:
//   1. Comprueba que quien llama está autenticado y es rol 'admin'.
//   2. Con la service_role: crea el usuario (email + contraseña temporal),
//      da de alta el centro, enlaza usuario→centro en `usuarios` (rol centro)
//      y marca la solicitud como atendida.
//   3. Devuelve el correo y la contraseña temporal para que el admin se los
//      pase al centro (podrá cambiarla luego).
//
// Despliegue (una vez): Supabase → Edge Functions → Deploy a new function →
//   nombre "dar-acceso" → pegar este archivo → Deploy. No hay que configurar
//   secretos: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
//   ya vienen inyectados en las Edge Functions.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// Contraseña temporal legible (sin caracteres ambiguos)
function generarClave(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // 1. ¿Quién llama? Debe estar autenticado y ser admin.
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'No autenticado' }, 401);
    const asUser = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !user) return json({ error: 'No autenticado' }, 401);
    const { data: perfil } = await asUser.from('usuarios').select('rol').eq('id', user.id).maybeSingle();
    if (!perfil || perfil.rol !== 'admin') return json({ error: 'Solo un administrador puede dar acceso.' }, 403);

    // 2. Datos del centro a crear
    const body = await req.json().catch(() => ({}));
    const email = (body.email ?? '').trim();
    const nombre = (body.nombre ?? '').trim();
    if (!email || !nombre) return json({ error: 'Faltan el correo o el nombre del centro.' }, 400);

    const admin = createClient(url, serviceKey);

    // 2a. Crear la cuenta de acceso (confirmada, con contraseña temporal)
    const tempPassword = generarClave();
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      const msg = createErr?.message ?? 'no se pudo crear el usuario';
      const yaExiste = /already been registered|already exists/i.test(msg);
      return json({ error: yaExiste ? 'Ya existe una cuenta con ese correo.' : 'No se pudo crear la cuenta: ' + msg }, 400);
    }
    const uid = created.user.id;

    // 2b. Dar de alta el centro
    const { data: centro, error: centroErr } = await admin.from('centros').insert({
      nombre,
      tipo: body.tipo || null,
      etapa: body.etapa || null,
      ruralidad: body.ruralidad || null,
      num_alumnos: body.num_alumnos ?? null,
    }).select('id').single();
    if (centroErr) {
      await admin.auth.admin.deleteUser(uid); // deshacer para no dejar cuentas sueltas
      return json({ error: 'No se pudo crear el centro: ' + centroErr.message }, 400);
    }

    // 2c. Enlazar usuario → centro (rol centro)
    const { error: usrErr } = await admin.from('usuarios').insert({ id: uid, centro_id: centro.id, rol: 'centro' });
    if (usrErr) {
      await admin.from('centros').delete().eq('id', centro.id);
      await admin.auth.admin.deleteUser(uid);
      return json({ error: 'No se pudo enlazar la cuenta con el centro: ' + usrErr.message }, 400);
    }

    // 2d. Marcar la solicitud como atendida (si venía de una)
    if (body.solicitud_id) {
      await admin.from('solicitudes_cuenta').update({ atendida: true }).eq('id', body.solicitud_id);
    }

    // 3. Credenciales para que el admin se las pase al centro
    return json({ ok: true, email, tempPassword });
  } catch (e) {
    return json({ error: 'Error inesperado: ' + String(e) }, 500);
  }
});
