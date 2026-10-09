// Массовое дополнение базы подшипников: масса, C, C0 через DeepSeek.
// Запуск: node enrich-run.js [сколько_подшипников]   (без числа = все)
const fs = require("fs"), path = require("path");
const KEY = process.env.DEEPSEEK_API_KEY;
const BASE = (process.env.BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.MODEL || "deepseek-v4-flash";
const LIMIT = +process.argv[2] || Infinity, BATCH = 10, PAR = 3;
(async () => {   // проверка связи до начала работы
  try { await fetch(BASE + "/models", { headers: { authorization: "Bearer " + (KEY || "x") } }); }
  catch (e) {
    const why = e.cause ? (e.cause.code || e.cause.message) : e.message;
    console.log("Нет связи с " + BASE + " (" + why + ").");
    if (/CERT|SELF_SIGNED|LEAF/i.test(String(why))) console.log("Причина: корпоративная сеть подменяет сертификат. Запустите на домашнем компьютере.");
    else console.log("Причина: сайт заблокирован или нет интернета. Откройте https://api.deepseek.com в браузере; если не открывается, запустите на домашнем компьютере.");
    process.exit(1);
  }
})();
if (!KEY) { console.log("Не задан ключ DEEPSEEK_API_KEY"); process.exit(1); }
const dir = __dirname, progFile = path.join(dir, "progress.json");
const list = JSON.parse(fs.readFileSync(path.join(dir, "bearings-list.json"), "utf8")).slice(0, LIMIT);
let prog = {}; try { prog = JSON.parse(fs.readFileSync(progFile, "utf8")); } catch {}
const todo = list.filter(b => !(b.iso in prog));
const batches = []; for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
console.log(`Всего: ${list.length}, уже сделано: ${list.length - todo.length}, осталось: ${todo.length} (${batches.length} запросов)`);

const num = v => typeof v === "number" && isFinite(v) && v > 0 ? v : null;
function clean(b, r) {                       // проверка правдоподобия
  const o = {}, need = b.missing;
  const env = Math.PI / 4 * (b.D * b.D - b.d * b.d) * b.B * 7.85e-6;   // масса сплошного кольца, кг
  const w = num(r.weight), C = num(r.C), C0 = num(r.C0);
  if (need.includes("weight") && w && w >= 0.2 * env && w <= env) o.weight = +w.toPrecision(3);
  if (need.includes("C") && C && C >= 0.5 && C <= 20000) o.C = +C.toPrecision(4);
  if (need.includes("C0") && C0 && C0 >= 0.3 && C0 <= 30000) o.C0 = +C0.toPrecision(4);
  const c = o.C || b.C, c0 = o.C0 || b.C0;
  if (c && c0 && (c0 / c < 0.25 || c0 / c > 3.5)) { delete o.C; delete o.C0; }
  return o;
}
async function ask(batch) {
  const data = batch.map(b => ({ iso: b.iso, gost: b.gost, d: b.d, D: b.D, B: b.B, type: b.type }));
  const prompt = `Ты инженер по подшипникам качения. Для каждого подшипника укажи: weight (масса, кг), C (динамическая грузоподъёмность, кН), C0 (статическая, кН) по каталогам SKF/FAG/NSK (типовые значения). Правила: если не уверен, ставь null; не выдумывай и не подгоняй числа. Поле iso возвращай точно как в запросе. Верни json: {"items":[{"iso":"...","weight":число|null,"C":число|null,"C0":число|null}]}.\nДанные:\n${JSON.stringify(data)}`;
  for (let t = 1; t <= 4; t++) {
    try {
      const r = await fetch(BASE + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
        body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 1800, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }) });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
      return JSON.parse(j.choices[0].message.content).items || [];
    } catch (e) {
      if (/Authentication|api key|401|Insufficient|Balance|402/i.test(e.message)) { console.log("Стоп: " + e.message + "\n(проверьте ключ и баланс DeepSeek)"); process.exit(1); }
      const why = e.cause ? (e.cause.code || e.cause.message) : ""; console.log(`  попытка ${t} не удалась: ${e.message} ${why}`); await new Promise(r => setTimeout(r, 2000 * t));
    }
  }
  return null;
}
let done = 0, fails = 0;
async function worker() {
  while (batches.length) {
    const batch = batches.shift(), items = await ask(batch);
    if (items) {
      const by = {}; items.forEach(x => by[x.iso] = x);
      batch.forEach(b => { prog[b.iso] = by[b.iso] ? clean(b, by[b.iso]) : {}; });
      fs.writeFileSync(progFile, JSON.stringify(prog));
    }
    if (!items) { fails++; console.log("  этот блок НЕ выполнен (нет связи), будет повторён при следующем запуске"); }
    done += batch.length; console.log(`Обработано ${done} из ${todo.length}`);
  }
}
(async () => {
  await Promise.all(Array.from({ length: PAR }, worker));
  const out = {}; let w = 0, c = 0, c0 = 0, empty = 0;
  for (const [k, v] of Object.entries(prog)) {
    if (!Object.keys(v).length) { empty++; continue; }
    out[k] = v; if (v.weight) w++; if (v.C) c++; if (v.C0) c0++;
  }
  fs.writeFileSync(path.join(dir, "enrich-data.js"), "window.ENRICH=" + JSON.stringify(out) + ";\n");
  console.log(`\nИтог: принято записей ${Object.keys(out).length}; масса ${w}, C ${c}, C0 ${c0}; без данных (ИИ не уверен или значения отклонены): ${empty}`);
  if (fails) console.log(`\nВНИМАНИЕ: не выполнено блоков: ${fails}. Проверьте интернет и запустите ещё раз: он продолжит с того же места.`);
  else console.log("Файл enrich-data.js создан. Загрузите его на GitHub рядом с index.html.");
})();
