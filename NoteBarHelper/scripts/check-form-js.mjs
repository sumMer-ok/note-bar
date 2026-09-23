// 浮窗表单的 JS 冒烟检查（零依赖，node 直接跑）：
//   node NoteBarHelper/scripts/check-form-js.mjs NoteBarHelper/Sources/NoteBarHelper/Resources/form.html
// 用最小 DOM 桩覆盖 form.html 用到的 API，验证：ready 信号、nbhInit 渲染、
// nbhFill 只填空字段、AI 按钮的加载/成功/失败三态、以及 submit 载荷字段形状不回归。
import fs from 'node:fs';
const html = fs.readFileSync(process.argv[2], 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 1) { console.error('expected exactly 1 script tag, got', scripts.length); process.exit(1); }
const code = scripts[0];

// 极简 DOM 桩：只覆盖 form.html 用到的 API
const makeEl = (id) => ({
  id, value: '', textContent: '', className: '', disabled: false, innerHTML: '', children: [],
  onclick: null, type: '',
  setAttribute(){}, appendChild(c){ this.children.push(c); },
});
const els = {};
for (const m of html.matchAll(/id="([^"]+)"/g)) els[m[1]] = makeEl(m[1]);
const messages = [];
const document = {
  getElementById: (id) => els[id] ?? null,
  querySelectorAll: () => [],
  createElement: () => makeEl('created'),
  createTextNode: (t) => ({ text: t }),
  addEventListener: () => {},
};
const window = { webkit: { messageHandlers: { nbh: { postMessage: (p) => messages.push(p) } } } };

const fn = new Function('window', 'document', code + '\n;return { nbhInit: window.nbhInit, nbhFill: window.nbhFill, nbhFillAI: window.nbhFillAI, nbhStatus: window.nbhStatus, aiClick: document.getElementById("ai").onclick, submit: document.getElementById("submit").onclick };');
const api = fn(window, document);

const assert = (cond, label) => { if (!cond) { console.error('FAIL:', label); process.exitCode = 1; } else console.log('ok:', label); };

// 1) ready 信号
assert(messages.some(m => m.action === 'ready'), 'ready 信号已发出');

// 2) nbhInit 填充
api.nbhInit({ word: 'consideration', sentence: 'For valuable consideration', definition: '', aliases: [],
              books: [{path:'law.canvas',name:'law',defaultChecked:true}], source: 'clipboard', originApp: 'WPS' });
assert(els.word.textContent === 'consideration', 'nbhInit 写入单词');
assert(els.sentence.value === 'For valuable consideration', 'nbhInit 写入例句');
assert(els.books.children.length === 1, 'nbhInit 渲染词库复选框');

// 3) 本地词典预填：空字段被填
api.nbhFill({ word: 'consideration', definition: "kənˌsɪdəˈreɪʃn\nn. 考虑", aliases: 'considerations' });
assert(els.definition.value === "kənˌsɪdəˈreɪʃn\nn. 考虑", 'nbhFill 填入释义');
assert(els.aliases.value === 'considerations', 'nbhFill 填入别名');
assert(els['ai-status'].textContent.includes('本地词典'), 'nbhFill 给出状态提示');

// 4) 预填不覆盖用户输入
els.definition.value = '用户自己写的';
els.aliases.value = 'mine';
api.nbhFill({ definition: 'x', aliases: 'y' });
assert(els.definition.value === '用户自己写的', 'nbhFill 不覆盖已填释义');
assert(els.aliases.value === 'mine', 'nbhFill 不覆盖已填别名');

// 5) AI 按钮点击 → postMessage
els.definition.value = '';
els.aliases.value = '';
messages.length = 0;
api.aiClick();
const aiMsg = messages.find(m => m.action === 'aiExplain');
assert(!!aiMsg, 'AI 按钮发出 aiExplain');
assert(aiMsg.word === 'consideration' && aiMsg.sentence === 'For valuable consideration', 'aiExplain 带单词与例句');
assert(els.ai.disabled === true && els.ai.textContent.includes('查询中'), 'AI 按钮进入加载态');
assert(els['ai-status'].textContent.includes('正在请求'), 'AI 按钮显示进行中提示');

// 6) AI 成功回填
api.nbhFillAI({ aliases: 'sue, sued', definition: '1）音标\n2）v. 起诉' });
assert(els.definition.value === '1）音标\n2）v. 起诉', 'nbhFillAI 回填释义');
assert(els.aliases.value === 'sue, sued', 'nbhFillAI 回填别名');
assert(els.ai.disabled === false && els.ai.textContent === 'AI 释义', 'AI 按钮恢复可用');
assert(els['ai-status'].className.includes('info'), '成功提示样式');

// 7) AI 失败：可见错误
api.nbhFillAI({ error: '未配置 API Key' });
assert(els['ai-status'].textContent.includes('未配置 API Key'), 'AI 失败显示错误文本');
assert(els['ai-status'].className.includes('err'), '错误使用 err 样式');
assert(els.ai.disabled === false, '失败后按钮可再次点击');

// 8) 提交载荷形状（不回归既有协议）
messages.length = 0;
els.definition.value = 'D'; els.aliases.value = 'A';
api.submit();
const submit = messages.find(m => m.action === 'submit');
assert(!!submit && submit.definition === 'D' && submit.aliases === 'A' && submit.sentence === 'For valuable consideration',
       'submit 载荷字段形状不变');
assert('color' in submit && 'books' in submit, 'submit 仍带 color/books');

// 9) nbhStatus 入口
api.nbhStatus('一句话', true);
assert(els['ai-status'].className.includes('err'), 'nbhStatus 支持错误样式');
console.log(process.exitCode ? 'JS 检查失败' : 'JS 检查全部通过');
