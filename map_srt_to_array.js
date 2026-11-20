#!/usr/bin/env node
// Usage: node map_srt_to_array.js <en.srt> <de.srt> [--name NAME] [--out FILE] [--batch-min 3]
//        [--context-sec 10] [--concurrency 4] [--model MODEL] [--max-ratio 4]
// Strips sound/action descriptions ([...] and all-caps (...)), splits both SRTs into sentences, batches them in time windows, asks the `copilot` CLI to align
// the sentences of each batch, and merges the results into:
//   var lang = { 'name': { en: [...], de: [...] } };
// en[i] corresponds to de[i]; a missing counterpart is ''.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opts = { 'batch-min': 3, 'context-sec': 10, concurrency: 4, retries: 3, 'max-len': 250, 'max-ratio': 4 };
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
  else files.push(args[i]);
}
if (files.length !== 2) {
  console.error('Usage: node map_srt_to_array.js <en.srt> <de.srt> [--name NAME] [--out FILE] [--model M]');
  process.exit(1);
}
const [enFile, deFile] = files;
const name = opts.name || path.basename(enFile).replace(/\.(en|de)?\.?srt$/i, '').replace(/[_.-]?(en|de)$/i, '');
const BATCH = Number(opts['batch-min']) * 60;
const CTX = Number(opts['context-sec']);

const toSec = (t) => {
  const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
};

const letters = (t) => (t.match(/\p{L}/gu) || []).length;
// Sound/action descriptions: any [..], ♪ song lyrics ♪, and (..) whose letters are (almost) all upper case, e.g. "(AUTOS HUPEN)".
// Mixed-case parentheses like "(Monica)" or "(Süßstoff)" are real content and kept.
function stripDescriptions(text) {
  return text
    .replace(/\u00e2\u0099\u00aa/g, '♪') // double-encoded UTF-8 ♪
    .replace(/♪[^♪]*♪/g, ' ')
    .replace(/♪.*$/, ' ') // unclosed lyric runs to the end of the cue
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(([^)]*)\)/g, (m, inner) => {
      const n = letters(inner), up = (inner.match(/\p{Lu}/gu) || []).length;
      return n >= 2 && up / n >= 0.8 ? ' ' : m;
    })
    .replace(/\s+/g, ' ')
    .replace(/(^|\s)[-–—](?=\s*(?:[-–—:]|$))/g, ' ') // speaker dashes left without text
    .replace(/^\s*:\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([:,.!?])/g, '$1')
    .trim();
}
const isTagOnly = (t) => !letters(stripDescriptions(t));

// Parse SRT and split cue text into sentences; each sentence gets the time of the cue it starts in.
function parseSentences(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const cues = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [s, e] = lines[ti].split('-->').map((x) => toSec(x));
    const text = stripDescriptions(lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, ''));
    if (text) cues.push({ start: s, end: e, text });
  }
  // Some subtitle files have no sentence punctuation at all: fall back to one sentence per cue.
  const punct = cues.filter((c) => /[.!?…]["'»)\]]*$/.test(c.text)).length / (cues.length || 1);
  if (punct < 0.3) return cues.map((c, i) => ({ id: i, start: c.start, text: c.text }));
  const sentences = [];
  let cur = null;
  for (const cue of cues) {
    // split into pieces ending at . ! ? … (optionally followed by closing quotes/brackets)
    const parts = cue.text.match(/.*?(?:[.!?…]+["'»)\]]*(?=\s|$)|$)/g).map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      if (!cur) cur = { start: cue.start, text: p };
      else cur.text += ' ' + p;
      if (/[.!?…]["'»)\]]*$/.test(p)) {
        sentences.push(cur);
        cur = null;
      }
    }
  }
  if (cur) sentences.push(cur);
  return sentences.map((s, i) => ({ id: i, start: s.start, text: s.text }));
}

function runCopilot(prompt) {
  return new Promise((resolve, reject) => {
    const a = ['-p', prompt, '-s', '--no-ask-user', '--no-custom-instructions', '--available-tools', 'none'];
    if (opts.model) a.push('--model', opts.model);
    const p = spawn('copilot', a, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`copilot exit ${code}: ${err}`))));
  });
}

function extractJson(text) {
  const start = text.indexOf('[');
  if (start < 0) throw new Error('no JSON array in response');
  // try progressively shorter slices ending at a ']' so trailing prose does not break parsing
  for (let end = text.lastIndexOf(']'); end > start; end = text.lastIndexOf(']', end - 1)) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(v)) return v;
    } catch {}
  }
  throw new Error('unparsable JSON in response');
}

async function mapBatch(b, label) {
  const fmt = (arr) => arr.map((s) => `${s.id}: ${s.text}`).join('\n');
  const prompt =
    `You align subtitle sentences of one TV episode between English and German.\n` +
    `Below are English (EN) and German (DE) sentences, each with a numeric id. Map them to each other in order.\n` +
    `Rules: a group may hold several sentences on either side (when one language splits/merges sentences differently); ` +
    `a sentence with no counterpart gets its own group with an empty list on the other side; ` +
    `every id must appear in exactly one group; keep groups in chronological order; ` +
    `sentences near the start/end of the lists may be context whose counterpart is missing, that is fine.\n` +
    `Only put EN and DE sentences in the same group if they are actual translations of each other (same meaning). ` +
    `Being at the same time is not enough: one side may have dialogue the other omits (e.g. translated foreign-language speech), ` +
    `which must stay unpaired with an empty list on the other side.\n` +
    `Output ONLY a JSON array, no prose, no code fence, of objects like {"en":[12],"de":[11,12]} or {"en":[3],"de":[]}.\n\n` +
    `EN:\n${fmt(b.en)}\n\nDE:\n${fmt(b.de)}\n`;
  let lastErr;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      // feed the previous validation error back, otherwise the model tends to repeat the same mistake
      const p = lastErr ? `${prompt}\nYour previous answer was rejected: ${lastErr.message.slice(0, 300)}. Fix that.\n` : prompt;
      const groups = extractJson(await runCopilot(p));
      const byId = { en: new Map(b.en.map((s) => [s.id, s])), de: new Map(b.de.map((s) => [s.id, s])) };
      const enIds = new Set(byId.en.keys()), deIds = new Set(byId.de.keys());
      const seenE = new Set(), seenD = new Set();
      for (const g of groups) {
        if (!g || !Array.isArray(g.en) || !Array.isArray(g.de)) throw new Error('bad group shape');
        for (const i of g.en) if (!enIds.has(i) || seenE.has(i)) throw new Error('bad/duplicate en id ' + i); else seenE.add(i);
        for (const i of g.de) if (!deIds.has(i) || seenD.has(i)) throw new Error('bad/duplicate de id ' + i); else seenD.add(i);
        if (g.en.length && g.de.length) {
          const eT = g.en.map((i) => byId.en.get(i).text).join(' '), dT = g.de.map((i) => byId.de.get(i).text).join(' ');
          if (isTagOnly(eT) !== isTagOnly(dT)) throw new Error(`description paired with dialogue: "${eT}" <> "${dT}"`);
        }
      }
      for (const s of [...b.en.filter(b.inCore).map((x) => ['en', x.id]), ...b.de.filter(b.inCore).map((x) => ['de', x.id])])
        if (!(s[0] === 'en' ? seenE : seenD).has(s[1])) throw new Error(`core ${s[0]} id ${s[1]} missing from mapping`);
      return groups;
    } catch (e) {
      lastErr = e;
      console.error(`[${label}] attempt ${attempt + 1} failed: ${e.message.slice(0, 200)}`);
    }
  }
  throw lastErr;
}

// Cut `text` at the boundary (sentence end > clause punctuation > space) closest to relative position `ratio`.
function cutAt(text, ratio) {
  const target = text.length * ratio;
  let best = -1, bestScore = Infinity;
  for (let i = 1; i < text.length; i++) {
    let w;
    if (/[.!?…]/.test(text[i - 1]) && text[i] === ' ') w = 0;
    else if (/[,;:\-–—]/.test(text[i - 1]) && text[i] === ' ') w = 0.5;
    else if (text[i] === ' ') w = 1;
    else continue;
    const score = Math.abs(i - target) * (1 + w);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best < 0 ? [text, ''] : [text.slice(0, best).trim(), text.slice(best).trim()];
}

// Split an aligned pair in two (recursively) while either side exceeds the max length.
function splitPair(e, d) {
  const max = Number(opts['max-len']);
  if (e.length <= max && d.length <= max) return [[e, d]];
  const ratio = 0.5;
  const [e1, e2] = e ? cutAt(e, ratio) : ['', ''];
  const [d1, d2] = d ? cutAt(d, ratio) : ['', ''];
  if ((!e1 || !e2) && (!d1 || !d2) && (e1 || d1) && (e2 || d2) === '') return [[e, d]]; // cannot split further
  return [...splitPair(e1, d1), ...splitPair(e2, d2)].filter(([a, b]) => a || b);
}

async function main() {
  const en = parseSentences(enFile), de = parseSentences(deFile);
  const end = Math.max(en.at(-1).start, de.at(-1).start);
  const batches = [];
  for (let t = 0; t <= end; t += BATCH) {
    const inCore = (s) => s.start >= t && s.start < t + BATCH;
    const inCtx = (s) => s.start >= t - CTX && s.start < t + BATCH + CTX;
    batches.push({ t, core: [t, t + BATCH], en: en.filter(inCtx), de: de.filter(inCtx), inCore });
  }
  console.error(`${en.length} EN / ${de.length} DE sentences, ${batches.length} batches`);

  const results = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const i = next++;
      const b = batches[i];
      if (!b.en.length && !b.de.length) { results[i] = []; continue; }
      results[i] = await mapBatch(b, `batch ${i + 1}/${batches.length}`);
      console.error(`batch ${i + 1}/${batches.length} done (${results[i].length} groups)`);
    }
  };
  await Promise.all(Array.from({ length: Number(opts.concurrency) }, worker));

  // Merge: a group belongs to the batch whose core window contains its earliest sentence.
  const usedE = new Set(), usedD = new Set();
  const groups = [];
  batches.forEach((b, i) => {
    for (const g of results[i]) {
      const times = [...g.en.map((x) => en[x].start), ...g.de.map((x) => de[x].start)];
      if (!times.length) continue;
      const t0 = Math.min(...times);
      if (t0 < b.core[0] || t0 >= b.core[1]) continue;
      if (g.en.some((x) => usedE.has(x)) || g.de.some((x) => usedD.has(x))) continue;
      g.en.forEach((x) => usedE.add(x));
      g.de.forEach((x) => usedD.add(x));
      groups.push({ t: t0, en: g.en, de: g.de });
    }
  });
  // Anything not covered becomes an unpaired entry.
  for (const s of en) if (!usedE.has(s.id)) groups.push({ t: s.start, en: [s.id], de: [] });
  for (const s of de) if (!usedD.has(s.id)) groups.push({ t: s.start, en: [], de: [s.id] });
  groups.sort((a, b) => a.t - b.t);

  const outEn = [], outDe = [];
  const maxRatio = Number(opts['max-ratio']);
  const fmtT = (t) => new Date(t * 1000).toISOString().slice(11, 19);
  let flagged = 0;
  for (const g of groups) {
    const eText = g.en.map((i) => en[i].text).join(' ');
    const dText = g.de.map((i) => de[i].text).join(' ');
    if (eText && dText && eText.length + dText.length >= 30) {
      const r = Math.max(eText.length, dText.length) / Math.min(eText.length, dText.length);
      if (r > maxRatio) {
        flagged++;
        console.error(`REVIEW ${fmtT(g.t)} length ratio ${r.toFixed(1)}:\n  EN: ${eText}\n  DE: ${dText}`);
      }
    }
    for (const [e, d] of splitPair(eText, dText)) {
      outEn.push(e);
      outDe.push(d);
    }
  }
  const js = `var lang = ${JSON.stringify({ [name]: { en: outEn, de: outDe } }, null, 2).replace(/"(en|de)":/g, '$1:')};\n`;
  if (opts.out) fs.writeFileSync(opts.out, js);
  else process.stdout.write(js);
  console.error(`${groups.length} entries (${groups.filter((g) => !g.en.length || !g.de.length).length} unpaired, ${flagged} flagged for review)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
