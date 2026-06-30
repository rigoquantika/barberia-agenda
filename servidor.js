// =============================================
// BARBERAPP - Servidor de Notificaciones WhatsApp
// Fase 3: Twilio + Supabase
// =============================================
// Requisitos previos:
//   node -v  (debe ser v16 o superior)
//   npm install express twilio @supabase/supabase-js node-cron dotenv
// Para correr: node servidor.js
// =============================================

require('dotenv').config();
const express    = require('express');
const twilio     = require('twilio');
const cron       = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── CONFIGURACIÓN ────────────────────────────────────────────
const CONFIG = {
  // Supabase
  SUPA_URL : process.env.SUPA_URL,
  SUPA_KEY : process.env.SUPA_KEY,
  // Twilio
  TWILIO_SID   : process.env.TWILIO_SID,
  TWILIO_TOKEN : process.env.TWILIO_TOKEN,
  TWILIO_WA    : process.env.TWILIO_WA || 'whatsapp:+14155238886', // número sandbox
  // Servidor
  PORT: process.env.PORT || 3000,
};

// Verificación de variables obligatorias
const requeridas = ['SUPA_URL','SUPA_KEY','TWILIO_SID','TWILIO_TOKEN'];
const faltantes = requeridas.filter(k => !CONFIG[k]);
if (faltantes.length) {
  console.error(`❌ Faltan variables de entorno: ${faltantes.join(', ')}`);
  console.error('   Configúralas en tu archivo .env (local) o en Railway → Variables (producción).');
  process.exit(1);
}

// ─── CLIENTES ─────────────────────────────────────────────────
const db      = createClient(CONFIG.SUPA_URL, CONFIG.SUPA_KEY);
const twClient = twilio(CONFIG.TWILIO_SID, CONFIG.TWILIO_TOKEN);

// ─── HELPER: ENVIAR WHATSAPP ──────────────────────────────────
async function enviarWA(numero, mensaje) {
  // Asegurar formato correcto
  const to = numero.startsWith('whatsapp:') ? numero : `whatsapp:${numero}`;
  try {
    const msg = await twClient.messages.create({
      from: CONFIG.TWILIO_WA,
      to,
      body: mensaje,
    });
    console.log(`✅ WA enviado a ${to} | SID: ${msg.sid}`);
    return { ok: true, sid: msg.sid };
  } catch (err) {
    console.error(`❌ Error enviando WA a ${to}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ─── HELPER: FECHA LEGIBLE ────────────────────────────────────
function fechaLegible(fechaStr) {
  const f = new Date(fechaStr + 'T12:00:00');
  return f.toLocaleDateString('es-HN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

// ─── ENDPOINT: CONFIRMACIÓN AL AGENDAR ───────────────────────
// La app HTML llama este endpoint justo después de guardar la cita
app.post('/api/confirmar', async (req, res) => {
  const { cita_id } = req.body;
  if (!cita_id) return res.status(400).json({ error: 'Falta cita_id' });

  try {
    // Obtener datos completos de la cita
    const { data, error } = await db
      .from('citas')
      .select(`
        id, fecha, hora_inicio, hora_fin, estado,
        clientes (nombre, whatsapp),
        servicios (nombre, emoji, duracion_min)
      `)
      .eq('id', cita_id)
      .single();

    if (error || !data) throw error || new Error('Cita no encontrada');

    const { clientes: cliente, servicios: servicio } = data;
    const fecha = fechaLegible(data.fecha);
    const hora  = data.hora_inicio.slice(0,5);
    const fin   = data.hora_fin.slice(0,5);

    const mensaje = `✅ *Cita Confirmada* 💈

Hola ${cliente.nombre}, tu cita ha sido agendada exitosamente.

📋 *Detalles:*
• Servicio: ${servicio.emoji} ${servicio.nombre}
• Fecha: ${fecha}
• Hora: ${hora} - ${fin}
• Duración: ${servicio.duracion_min} min

Te enviaremos un recordatorio el día anterior. 

¡Hasta pronto! 🙌`;

    const result = await enviarWA(cliente.whatsapp, mensaje);
    res.json({ ok: result.ok, mensaje: 'Confirmación enviada' });

  } catch (err) {
    console.error('Error en /api/confirmar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ENDPOINT: WEBHOOK (cliente escribe al número de WhatsApp) ─
// Twilio llama este endpoint cuando alguien escribe al sandbox
app.post('/webhook/whatsapp', (req, res) => {
  const { Body, From } = req.body;
  const texto = (Body || '').trim().toLowerCase();
  console.log(`📨 Mensaje recibido de ${From}: ${Body}`);

  const twiml = new twilio.twiml.MessagingResponse();

  if (texto.includes('cita') || texto.includes('agendar') || texto.includes('hola')) {
    twiml.message(
      `¡Hola! 👋 Bienvenido a nuestra barbería.\n\nPara agendar tu cita haz clic en el siguiente enlace:\n\n🔗 http://localhost:3000/agendar\n\nTe atendemos de lunes a viernes, 8:00 - 20:00 h. ✂️`
    );
  } else {
    twiml.message(
      `Hola 😊 Para agendar una cita escríbenos "cita" o visita:\n🔗 http://localhost:3000/agendar`
    );
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── CRON: RECORDATORIOS (corre todos los días a las 9:00 AM) ──
cron.schedule('0 9 * * *', async () => {
  console.log('\n⏰ Ejecutando recordatorios del día...');

  // Fecha de mañana
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaManana = manana.toISOString().split('T')[0];

  try {
    const { data: citas, error } = await db
      .from('citas')
      .select(`
        id, fecha, hora_inicio, hora_fin,
        clientes (nombre, whatsapp),
        servicios (nombre, emoji)
      `)
      .eq('fecha', fechaManana)
      .eq('estado', 'confirmada')
      .eq('recordatorio_enviado', false);

    if (error) throw error;

    console.log(`📅 Citas mañana (${fechaManana}): ${citas.length}`);

    for (const cita of citas) {
      const { clientes: cliente, servicios: servicio } = cita;
      const hora = cita.hora_inicio.slice(0,5);
      const fin  = cita.hora_fin.slice(0,5);

      const mensaje = `⏰ *Recordatorio de Cita* 💈

Hola ${cliente.nombre}, te recordamos que mañana tienes una cita.

📋 *Detalles:*
• Servicio: ${servicio.emoji} ${servicio.nombre}
• Mañana a las: ${hora} - ${fin}

Por favor llega 5 minutos antes. Si necesitas cancelar escríbenos. ✂️`;

      const result = await enviarWA(cliente.whatsapp, mensaje);

      if (result.ok) {
        // Marcar recordatorio como enviado
        await db.from('citas').update({ recordatorio_enviado: true }).eq('id', cita.id);
      }
    }
    console.log('✅ Recordatorios completados\n');
  } catch (err) {
    console.error('❌ Error en recordatorios:', err.message);
  }
}, { timezone: 'America/Tegucigalpa' });

// ─── CRON: SEGUIMIENTO A 15 DÍAS (corre todos los días a las 10:00 AM) ──
cron.schedule('0 10 * * *', async () => {
  console.log('\n🔄 Ejecutando seguimiento de 15 días...');

  // Fecha de hace 15 días
  const hace15 = new Date();
  hace15.setDate(hace15.getDate() - 15);
  const fecha15 = hace15.toISOString().split('T')[0];

  try {
    const { data: citas, error } = await db
      .from('citas')
      .select(`
        id, fecha, hora_inicio,
        clientes (nombre, whatsapp),
        servicios (nombre, emoji)
      `)
      .eq('fecha', fecha15)
      .eq('estado', 'completada')
      .eq('seguimiento_enviado', false);

    if (error) throw error;

    console.log(`🔄 Citas para seguimiento (agendadas el ${fecha15}): ${citas.length}`);

    for (const cita of citas) {
      const { clientes: cliente, servicios: servicio } = cita;

      const mensaje = `💈 *Han pasado 15 días desde tu última visita*

Hola ${cliente.nombre}, ¿cómo estás? 😊

Notamos que fue hace 15 días que viniste para tu *${servicio.nombre}* y queremos recordarte que es buen momento para renovar tu look. ✨

¿Agendamos tu próxima cita?\n🔗 http://localhost:3000/agendar

¡Te esperamos! 💇`;

      const result = await enviarWA(cliente.whatsapp, mensaje);

      if (result.ok) {
        await db.from('citas').update({ seguimiento_enviado: true }).eq('id', cita.id);
      }
    }
    console.log('✅ Seguimientos completados\n');
  } catch (err) {
    console.error('❌ Error en seguimientos:', err.message);
  }
}, { timezone: 'America/Tegucigalpa' });

// ─── ENDPOINT: HEALTH CHECK ───────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    servidor: 'BarberApp Notificaciones',
    hora: new Date().toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa' }),
  });
});

// ─── ENDPOINT: PRUEBA MANUAL ──────────────────────────────────
// GET /test-wa?numero=+50499999999&msg=Hola prueba
app.get('/test-wa', async (req, res) => {
  const { numero, msg } = req.query;
  if (!numero) return res.status(400).json({ error: 'Falta ?numero=+504...' });
  const result = await enviarWA(numero, msg || '✅ Prueba desde BarberApp servidor');
  res.json(result);
});

// ─── ARRANQUE ─────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   💈 BarberApp - Servidor activo       ║
║   Puerto: ${CONFIG.PORT}                         ║
║                                        ║
║   Endpoints:                           ║
║   POST /api/confirmar                  ║
║   POST /webhook/whatsapp               ║
║   GET  /health                         ║
║   GET  /test-wa?numero=+504...         ║
║                                        ║
║   Crons activos:                       ║
║   09:00 AM - Recordatorios             ║
║   10:00 AM - Seguimiento 15 días       ║
╚════════════════════════════════════════╝
  `);
});
