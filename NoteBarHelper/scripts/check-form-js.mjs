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

// 10) 样式回归护栏：全局 width:100% 绝不能命中复选框。
// 现场 bug：`input, textarea, select { width: 100% }` 把 checkbox 拉成整行宽，
// 后面的词库名被挤成竖排一列一个字；1 个词库看不出来，3 个就暴露。
const styleBlock = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');   // 去掉注释，否则 /* ... */ 会粘在后面的选择器上
const rules = [...styleBlock.matchAll(/(^|\n)\s*([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({ selector: m[2].trim().replace(/\s+/g, ' '), body: m[3] }));
const widthFullOnCheckbox = rules.filter(r =>
  r.body.includes('width: 100%') &&
  r.selector.split(',').some(part => part.trim() === 'input'));
assert(widthFullOnCheckbox.length === 0, '全局 width:100% 不得命中裸 input（复选框会被拉成整行宽）');

const checkboxRule = rules.find(r => r.selector.split(',').some(p => p.trim() === 'input[type="checkbox"]'));
assert(!!checkboxRule, '存在 input[type="checkbox"] 的显式尺寸规则');
assert(/width:\s*13px/.test(checkboxRule?.body ?? '') && /flex:\s*0 0 auto/.test(checkboxRule?.body ?? ''),
       '复选框固定 13px 且不参与 flex 伸缩');

const booksRule = rules.find(r => r.selector === '.books');
assert(/display:\s*flex/.test(booksRule?.body ?? '') && /flex-wrap:\s*wrap/.test(booksRule?.body ?? ''),
       '.books 仍是可换行的 flex 容器');
const booksLabelRule = rules.find(r => r.selector === '.books label');
assert(/white-space:\s*nowrap/.test(booksLabelRule?.body ?? '') && /display:\s*inline-flex/.test(booksLabelRule?.body ?? ''),
       '.books label 仍是 inline-flex + nowrap（词库名不逐字折行）');

// 复选框的 DOM 结构也没变：label > input[type=checkbox] + 文本
const firstBook = els.books.children[0];
const bookInput = firstBook?.children?.[0];
assert(bookInput?.type === 'checkbox' && firstBook.children.length === 2,
       '词库项仍是 label > input + 文本（CSS 的 :not([type=checkbox]) 依赖它）');

console.log(process.exitCode ? 'JS 检查失败' : 'JS 检查全部通过');
