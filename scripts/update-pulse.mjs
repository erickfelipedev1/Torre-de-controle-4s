// scripts/update-pulse.mjs
//
// Roda pelo GitHub Actions (.github/workflows/update-pulse.yml) algumas vezes por dia.
// 1) Busca dados frescos do Instagram via Windsor.ai
// 2) Pede pra API da Anthropic reescrever as anotações curtas (mesmo tom do relatório original)
// 3) Regrava os blocos PULSE / REACH_30D / RECENT_POSTS dentro de index.html, entre os
//    marcadores "// XXX_START" e "// XXX_END"
//
// Precisa de duas variáveis de ambiente (definidas como GitHub Actions secrets):
//   WINDSOR_API_KEY   — chave da API do Windsor.ai
//   ANTHROPIC_API_KEY — chave da API da Anthropic (console.anthropic.com)
//
// Se algo der errado ao chamar a Anthropic, o script ainda atualiza os números
// (que são o que mais importa) e só mantém o texto de análise da rodada anterior.

import { readFileSync, writeFileSync } from "node:fs";

const HTML_PATH = new URL("../index.html", import.meta.url);
// Modelo usado para reescrever as anotações. Ajuste se precisar —
// veja https://docs.claude.com/en/docs/about-claude/models pra IDs atuais.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const WINDSOR_API_KEY = requireEnv("WINDSOR_API_KEY");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // opcional (sem ela, só números atualizam)

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Faltando variável de ambiente ${name}`);
    process.exit(1);
  }
  return v;
}

function fmtDateBR(d) {
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtDayMonth(dateStr) {
  // dateStr vem como YYYY-MM-DD do Windsor.ai
  const [, m, d] = dateStr.split("-");
  return `${d}/${m}`;
}

async function windsorFetch(fields, { dateFrom, dateTo }) {
  const url = new URL("https://connectors.windsor.ai/all");
  url.searchParams.set("api_key", WINDSOR_API_KEY);
  url.searchParams.set("fields", fields.join(","));
  url.searchParams.set("date_from", dateFrom);
  url.searchParams.set("date_to", dateTo);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Windsor.ai respondeu ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data || [];
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function avg(nums) {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

// ---- 1) Buscar dados no Windsor.ai --------------------------------------

const today = daysAgo(0);
const from30 = daysAgo(29); // folga de alguns dias pra garantir 30 linhas úteis

const accountRows = (
  await windsorFetch(
    ["date", "followers_count", "follower_count_1d", "media_count", "reach_1d"],
    { dateFrom: from30, dateTo: today }
  )
).sort((a, b) => a.date.localeCompare(b.date));

const mediaRows = (
  await windsorFetch(["timestamp", "media_type", "media_reach"], {
    dateFrom: from30,
    dateTo: today,
  })
).filter((r) => r.timestamp);

if (!accountRows.length) {
  console.error("Windsor.ai não retornou dados de conta — abortando sem alterar o arquivo.");
  process.exit(1);
}

const last = accountRows[accountRows.length - 1];
const last30 = accountRows.slice(-30);

const followers = Number(last.followers_count);
const mediaCount = Number(last.media_count);
const accountReach30dAvg = avg(last30.map((r) => Number(r.reach_1d || 0)));
const newFollowersDayAvg = avg(last30.map((r) => Number(r.follower_count_1d || 0)));

const REACH_30D = last30.map((r) => ({ d: fmtDayMonth(r.date), v: Number(r.reach_1d || 0) }));

const mediaTagged = mediaRows
  .map((r) => {
    const type = String(r.media_type || "").toUpperCase();
    const t = type === "CAROUSEL_ALBUM" ? "Carrossel" : type === "IMAGE" ? "Imagem" : "Reel";
    return { date: r.timestamp.slice(0, 10), t, reach: Number(r.media_reach || 0) };
  })
  .sort((a, b) => a.date.localeCompare(b.date));

const RECENT_POSTS = mediaTagged
  .filter((m) => m.t !== "Imagem")
  .map((m) => ({ d: fmtDayMonth(m.date), t: m.t, reach: m.reach }));

const reelsOnly = mediaTagged.filter((m) => m.t === "Reel");
const cutRecent = daysAgo(14);
const cutPrior = daysAgo(28);
const reelsRecent = reelsOnly.filter((m) => m.date >= cutRecent);
const reelsPrior = reelsOnly.filter((m) => m.date >= cutPrior && m.date < cutRecent);
const reachReelSet = avg(reelsRecent.map((m) => m.reach));
const reachReelPrior = avg(reelsPrior.map((m) => m.reach));

// ---- 2) Ler estado anterior do index.html (pra dar contexto à IA) -------

let html = readFileSync(HTML_PATH, "utf8");

function extractBlock(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker);
  if (s === -1 || e === -1 || e < s) return null;
  return src.slice(s + startMarker.length, e);
}

function extractField(pulseSrc, key) {
  const re = new RegExp(`${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = pulseSrc && pulseSrc.match(re);
  return m ? m[1].replace(/\\"/g, '"') : null;
}
function extractNumberField(pulseSrc, key) {
  const re = new RegExp(`${key}\\s*:\\s*([0-9]+)`);
  const m = pulseSrc && pulseSrc.match(re);
  return m ? Number(m[1]) : null;
}

const prevPulseSrc = extractBlock(html, "// PULSE_START", "// PULSE_END");
const previous = {
  fetchedAt: extractField(prevPulseSrc, "fetchedAt"),
  followers: extractNumberField(prevPulseSrc, "followers"),
  mediaCount: extractNumberField(prevPulseSrc, "mediaCount"),
  reachReelSet: extractNumberField(prevPulseSrc, "reachReelSet"),
  achadoHtml: extractField(prevPulseSrc, "achadoHtml"),
};

// ---- 3) Pedir pra Anthropic reescrever as anotações ----------------------

const mediaDelta = previous.mediaCount != null ? mediaCount - previous.mediaCount : 0;
const fallbackTexts = {
  followersDeltaText:
    previous.followers != null
      ? `${followers - previous.followers >= 0 ? "+" : ""}${followers - previous.followers} desde a última leitura`
      : "",
  mediaDeltaText: `${mediaDelta} ${mediaDelta === 1 ? "nova" : "novas"} desde a última leitura (${previous.mediaCount ?? "—"} → ${mediaCount})`,
  accountReach30dNote: "Média dos últ. 30 dias.",
  reachReelLabel: "Alcance médio/Reel · período atual",
  reachReelSetNote: `vs. ${reachReelPrior} na janela anterior.`,
  achadoHtml: previous.achadoHtml || "",
};

let texts = fallbackTexts;

if (ANTHROPIC_API_KEY) {
  try {
    texts = await writeAnnotations({
      followers,
      previousFollowers: previous.followers,
      mediaCount,
      previousMediaCount: previous.mediaCount,
      accountReach30dAvg,
      newFollowersDayAvg,
      reachReelSet,
      previousReachReelSet: previous.reachReelSet,
      reachReelPrior,
      reelsRecentN: reelsRecent.length,
      reelsPriorN: reelsPrior.length,
      previousAchadoHtml: previous.achadoHtml,
      previousFetchedAt: previous.fetchedAt,
      fetchedAt: fmtDateBR(new Date()),
    });
  } catch (err) {
    console.error("Falha ao chamar a Anthropic, mantendo texto da rodada anterior:", err);
  }
} else {
  console.warn("ANTHROPIC_API_KEY não definida — só os números serão atualizados.");
}

async function writeAnnotations(ctx) {
  const prompt = `Você escreve as anotações curtas de um dashboard interno de performance de Instagram (em português do Brasil), no mesmo tom do texto original: direto, analítico, sem enrolação, marcando explicitamente **DADO** (o que os números confirmam) vs **HIPÓTESE** (o que ainda não dá pra confirmar) quando fizer sentido.

Dados desta leitura (${ctx.fetchedAt}):
- Seguidores: ${ctx.followers} (leitura anterior de ${ctx.previousFetchedAt ?? "—"}: ${ctx.previousFollowers ?? "—"})
- Mídias publicadas no total: ${ctx.mediaCount} (leitura anterior: ${ctx.previousMediaCount ?? "—"})
- Alcance diário médio de conta (últ. 30 dias): ${ctx.accountReach30dAvg}
- Novos seguidores/dia (média últ. 30 dias): ${ctx.newFollowersDayAvg}
- Alcance médio por Reel, janela mais recente (~14 dias, n=${ctx.reelsRecentN}): ${ctx.reachReelSet}
- Alcance médio por Reel, janela anterior (~14 dias antes dessa, n=${ctx.reelsPriorN}): ${ctx.reachReelPrior}
- Leitura anterior de alcance médio/Reel: ${ctx.previousReachReelSet ?? "—"}
- Texto de "achado" da rodada anterior (pra você manter continuidade e não repetir do zero): ${ctx.previousAchadoHtml ?? "(nenhum)"}

Responda SOMENTE com um JSON válido (sem markdown, sem comentário antes ou depois) com exatamente estas chaves, todas string:
{
  "followersDeltaText": "algo tipo '+54 desde DD/MM' comparando com a leitura anterior",
  "mediaDeltaText": "algo tipo 'N novas desde a última leitura (X → Y)'",
  "accountReach30dNote": "uma frase curta sobre o alcance diário de conta",
  "reachReelLabel": "rótulo curto do card de alcance/Reel, SEM citar um mês específico (ex: 'Alcance médio/Reel · período atual')",
  "reachReelSetNote": "frase curta comparando a janela atual com a anterior, com o percentual de variação",
  "achadoHtml": "parágrafo curto (2-5 frases) no estilo 'Achado atualizado (${ctx.fetchedAt}): ...', pode usar tags <b> pra destacar DADO/HIPÓTESE, sem usar aspas duplas dentro do texto"
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic respondeu ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const text = json.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Resposta da Anthropic sem JSON reconhecível: ${text}`);
  const parsed = JSON.parse(jsonMatch[0]);
  const required = [
    "followersDeltaText",
    "mediaDeltaText",
    "accountReach30dNote",
    "reachReelLabel",
    "reachReelSetNote",
    "achadoHtml",
  ];
  for (const k of required) {
    if (typeof parsed[k] !== "string") throw new Error(`Campo ${k} ausente/ inválido na resposta`);
  }
  return parsed;
}

// ---- 4) Regravar os blocos no index.html ---------------------------------

const fetchedAt = fmtDateBR(new Date());

const pulseObj = {
  fetchedAt,
  followers,
  mediaCount,
  accountReach30dAvg,
  newFollowersDayAvg,
  reachReelSet,
  followersDeltaText: texts.followersDeltaText,
  mediaDeltaText: texts.mediaDeltaText,
  accountReach30dNote: texts.accountReach30dNote,
  reachReelLabel: texts.reachReelLabel,
  reachReelSetNote: texts.reachReelSetNote,
  achadoHtml: texts.achadoHtml,
};

function jsObjectLiteral(obj, indent = "  ") {
  const lines = Object.entries(obj).map(([k, v]) => {
    const val = typeof v === "number" ? String(v) : JSON.stringify(v);
    return `${indent}${k}: ${val},`;
  });
  return `{\n${lines.join("\n")}\n}`;
}

function jsArrayLiteral(arr) {
  return `[\n${arr.map((o) => JSON.stringify(o).replace(/"([a-zA-Z0-9_]+)":/g, "$1:")).join(",\n")}\n]`;
}

function replaceBlock(src, startMarker, endMarker, newInner) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(`Marcadores ${startMarker}/${endMarker} não encontrados em index.html`);
  }
  return src.slice(0, s + startMarker.length) + newInner + src.slice(e);
}

html = replaceBlock(html, "// PULSE_START", "// PULSE_END", `\nconst PULSE = ${jsObjectLiteral(pulseObj)};\n`);
html = replaceBlock(
  html,
  "// REACH_30D_START",
  "// REACH_30D_END",
  `\nconst REACH_30D = ${jsArrayLiteral(REACH_30D)};\n`
);
html = replaceBlock(
  html,
  "// RECENT_POSTS_START",
  "// RECENT_POSTS_END",
  `\nconst RECENT_POSTS = ${jsArrayLiteral(RECENT_POSTS)};\n`
);

writeFileSync(HTML_PATH, html, "utf8");
console.log(`index.html atualizado — ${fetchedAt} · seguidores=${followers} · mídias=${mediaCount}`);
