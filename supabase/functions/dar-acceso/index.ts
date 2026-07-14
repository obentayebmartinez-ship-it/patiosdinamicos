// ============================================================
// Edge Function (desplegada como "rapid-handler") — dos acciones,
// según el campo `accion` del cuerpo:
//   • 'dar-acceso'    → crea la cuenta de un centro (usuario + centro +
//                       vínculo) y devuelve una contraseña temporal.
//   • 'borrar-centro' → borra un centro con TODOS sus datos y las cuentas
//                       de acceso asociadas.
// Vive en el servidor porque usa la clave maestra (service_role), que
// NUNCA puede estar en el navegador. Solo un admin puede llamarla.
//
// Despliegue / actualización: Supabase → Edge Functions → (tu función) →
//   pegar este archivo → Deploy. No hay que configurar secretos:
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY ya vienen
//   inyectados en las Edge Functions.
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
    if (!perfil || perfil.rol !== 'admin') return json({ error: 'Solo un administrador puede hacer esto.' }, 403);

    const body = await req.json().catch(() => ({}));
    const accion = body.accion ?? 'dar-acceso';
    const admin = createClient(url, serviceKey);

    // ---------- Acción: dar acceso (crear cuenta de centro) ----------
    if (accion === 'dar-acceso') {
      const email = (body.email ?? '').trim();
      const nombre = (body.nombre ?? '').trim();
      if (!email || !nombre) return json({ error: 'Faltan el correo o el nombre del centro.' }, 400);

      const tempPassword = generarClave();
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password: tempPassword, email_confirm: true,
      });
      if (createErr || !created?.user) {
        const msg = createErr?.message ?? 'no se pudo crear el usuario';
        const yaExiste = /already been registered|already exists/i.test(msg);
        return json({ error: yaExiste ? 'Ya existe una cuenta con ese correo.' : 'No se pudo crear la cuenta: ' + msg }, 400);
      }
      const uid = created.user.id;

      const { data: centro, error: centroErr } = await admin.from('centros').insert({
        nombre,
        tipo: body.tipo || null,
        etapa: body.etapa || null,
        ruralidad: body.ruralidad || null,
        num_alumnos: body.num_alumnos ?? null,
      }).select('id').single();
      if (centroErr) {
        await admin.auth.admin.deleteUser(uid);
        return json({ error: 'No se pudo crear el centro: ' + centroErr.message }, 400);
      }

      const { error: usrErr } = await admin.from('usuarios').insert({ id: uid, centro_id: centro.id, rol: 'centro' });
      if (usrErr) {
        await admin.from('centros').delete().eq('id', centro.id);
        await admin.auth.admin.deleteUser(uid);
        return json({ error: 'No se pudo enlazar la cuenta con el centro: ' + usrErr.message }, 400);
      }

      if (body.solicitud_id) {
        await admin.from('solicitudes_cuenta').update({ atendida: true }).eq('id', body.solicitud_id);
      }
      return json({ ok: true, email, tempPassword });
    }

    // ---------- Acción: borrar centro (con sus datos y cuentas) ----------
    if (accion === 'borrar-centro') {
      const centroId = body.centro_id;
      if (!centroId) return json({ error: 'Falta el identificador del centro.' }, 400);

      // Cuentas de acceso ligadas a ese centro (antes de borrarlo)
      const { data: cuentas } = await admin.from('usuarios').select('id').eq('centro_id', centroId);

      // Borrar el centro: cascada a patios, incidencias, ocupaciones,
      // encuestas y sesiones (todas con on delete cascade). usuarios queda
      // con centro_id null (on delete set null) hasta borrar su cuenta.
      const { error: delErr } = await admin.from('centros').delete().eq('id', centroId);
      if (delErr) return json({ error: 'No se pudo borrar el centro: ' + delErr.message }, 400);

      // Borrar las cuentas de acceso (cascada a la fila de `usuarios`)
      for (const c of cuentas ?? []) {
        await admin.auth.admin.deleteUser(c.id);
      }
      return json({ ok: true });
    }

    return json({ error: 'Acción no reconocida.' }, 400);
  } catch (e) {
    return json({ error: 'Error inesperado: ' + String(e) }, 500);
  }
});
