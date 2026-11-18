/**
 * Incident inbox CLI — the "pending fixes" list behind each Telegram ping.
 *
 * Lists every live (open/acknowledged) warning/critical alert with its stored
 * evidence: error counts, sample failing URLs + messages, job_execution ids.
 * Meant to be read by a human or handed to an agent ("revisá los incidentes
 * abiertos"); the playbook is docs/INCIDENTES.md.
 *
 * Usage (use `npx tsx` directly — PowerShell drops `--` in `npm run … -- <flags>`):
 *   npx tsx --env-file=.env scripts/incidents.ts                 list live incidents
 *   npx tsx --env-file=.env scripts/incidents.ts --super=vea     only one chain
 *   npx tsx --env-file=.env scripts/incidents.ts --json          raw rows (for tooling)
 *   npx tsx --env-file=.env scripts/incidents.ts --resolve=<id>[,<id>] [--note="qué se hizo"]
 *
 * Scrape incidents also auto-resolve on the next healthy run; --resolve is for
 * closing one by hand after a fix (or for revista incidents, which don't).
 */

import { db } from '../src/shared/db.js';

function argVal(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

interface IncidentRow {
  id: string;
  severity: string;
  type: string;
  supermarket_id: string | null;
  title: string;
  message: string;
  context: Record<string, unknown>;
  evidence: Record<string, unknown>;
  status: string;
  occurrences: number;
  created_at: string;
  last_seen_at: string;
}

async function list(): Promise<void> {
  let query = db
    .from('alerts')
    .select(
      'id, severity, type, supermarket_id, title, message, context, evidence, status, occurrences, created_at, last_seen_at',
    )
    .in('status', ['open', 'acknowledged'])
    .in('severity', ['warning', 'critical'])
    .order('severity', { ascending: true })
    .order('last_seen_at', { ascending: false });
  const superId = argVal('super');
  if (superId) query = query.eq('supermarket_id', superId);

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as IncidentRow[];

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No hay incidentes abiertos.');
    return;
  }

  console.log(`${rows.length} incidente(s) abierto(s)\n`);
  for (const r of rows) {
    console.log(`## [${r.severity.toUpperCase()}] ${r.title}`);
    console.log(`id: ${r.id} | tipo: ${r.type} | cadena: ${r.supermarket_id ?? '-'} | estado: ${r.status}`);
    console.log(
      `abierto: ${r.created_at} | visto por última vez: ${r.last_seen_at} | detecciones: ${r.occurrences}`,
    );
    console.log(r.message);

    const ev = r.evidence ?? {};
    if (ev.error_counts && typeof ev.error_counts === 'object') {
      console.log(`errores: ${JSON.stringify(ev.error_counts)}`);
    }
    if (typeof ev.run_id === 'string') console.log(`run: ${ev.run_id}`);
    if (typeof ev.card === 'string') console.log(`tarjeta: ${ev.card}`);
    const samples = Array.isArray(ev.samples) ? (ev.samples as Array<Record<string, unknown>>) : [];
    if (samples.length > 0) {
      console.log('muestras:');
      for (const s of samples) {
        console.log(`  - [${String(s.error_type)}] ${String(s.external_url ?? s.supermarket_product_id)}`);
        if (s.error_message) console.log(`      ${String(s.error_message)}`);
      }
    }
    if (Object.keys(ev).length === 0 && Object.keys(r.context ?? {}).length > 0) {
      console.log(`contexto: ${JSON.stringify(r.context)}`);
    }
    console.log('');
  }
}

async function resolve(ids: string[], note: string | undefined): Promise<void> {
  for (const id of ids) {
    const { data, error } = await db.from('alerts').select('id, title, context').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) {
      console.log(`${id}: no existe`);
      continue;
    }
    const context = { ...(data.context as Record<string, unknown>) };
    if (note) context.resolution_note = note;
    const { error: updateErr } = await db
      .from('alerts')
      .update({ status: 'resolved', resolved_at: new Date().toISOString(), context })
      .eq('id', id);
    if (updateErr) throw updateErr;
    console.log(`${id}: resuelto (${data.title as string})`);
  }
}

async function main(): Promise<void> {
  const toResolve = argVal('resolve');
  if (toResolve) {
    await resolve(
      toResolve.split(',').map((s) => s.trim()).filter(Boolean),
      argVal('note'),
    );
    return;
  }
  await list();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
