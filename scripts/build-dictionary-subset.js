/**
 * 生成「常用词子集」dictionary.lite.json（随仓库入库，供公开克隆者离线查常用词）。
 *
 * 为什么不直接提交全量：dictionary.json 约 363MB，远超 GitHub 单文件 100MB 上限，
 * 此前只能靠 Git LFS 存指针，新克隆拿到的是 134 字节的坏指针，本地查词直接不可用。
 * 子集约 1.4 万条 / 1.8MB，直接进普通 git、不走 LFS。
 *
 * ── 权威生成方式（推荐）───────────────────────────────────────────────────
 * 需要词库源文件 AutoCompleteData.db（不在公开仓库中），复用已有脚本的
 * --mode common：SQL 过滤 collins > 0 OR oxford = 1，即柯林斯星级 / 牛津 3000 常用词：
 *
 *   node scripts/build-dictionary.js --mode common --out dictionary.lite.json
 *
 * ── 无源文件时的降级路径 ──────────────────────────────────────────────────
 * 只能从已有的全量 dictionary.json 裁剪。此时**无法还原 collins/oxford 词频信息**，
 * 因为该字段只存在于 .db 中；任何纯启发式（按词长、按字母分布）都会明显跑偏——
 * 实测按词长排序会选进 'aaaa'、漏掉 'abandon' 与 'computer'。所以本脚本在这里
 * **不做猜测**，改为：仅当调用方显式提供一份常用词表（--allow plain）时才裁剪，
 * 并在输出里如实标注这是无频次信息的近似结果。
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(name, fallback) {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
function hasFlag(name) {
    return args.indexOf(name) >= 0;
}

const DATA_DIR = path.join(__dirname, '..', 'src', 'hiwords', 'data');
const inPath = path.join(DATA_DIR, getArg('--in', 'dictionary.json'));
const outName = getArg('--out', 'dictionary.lite.json');
const limit = Number(getArg('--limit', '14000'));

/** 释义必须是可读文本 */
function isUsableEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (!Array.isArray(entry.d) || entry.d.length === 0) return false;
    return entry.d.some(t => typeof t === 'string' && t.trim().length > 0);
}

/** 词条形态正常：无数字、无多余符号、长度合理 */
function isWellFormed(word) {
    if (!word || word.length < 2 || word.length > 28) return false;
    if (/\d/.test(word)) return false;
    return /^[a-z][a-z '\-/]*$/.test(word);
}

function main() {
    if (!hasFlag('--allow plain')) {
        console.error(
            '拒绝猜测：缺少 AutoCompleteData.db 时无法还原 collins/oxford 词频信息。\n\n' +
            '推荐（需要词库源文件，结果与仓库已入库的 dictionary.lite.json 一致）：\n' +
            '  node scripts/build-dictionary.js --mode common --out dictionary.lite.json\n\n' +
            '若确实要从已有全量 dictionary.json 裁剪一份近似子集，请显式加 --allow plain，\n' +
            '并清楚结果质量会明显下降。'
        );
        process.exit(1);
    }

    if (!fs.existsSync(inPath)) {
        console.error(`找不到全量词典: ${inPath}`);
        console.error('请先执行 npm run build:dictionary（需自备 AutoCompleteData.db）。');
        process.exit(1);
    }

    console.log('读取全量词典（约 363MB，需要一点时间）...');
    const full = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
    console.log(`全量词条: ${Object.keys(full).length}`);

    const candidates = [];
    for (const [word, entry] of Object.entries(full)) {
        if (isWellFormed(word) && isUsableEntry(entry)) candidates.push(word);
    }
    console.log(`形态正常的词条: ${candidates.length}`);

    // ⚠️ 无词频信息的降级排序：只能按字典序，保证可复现（全序、无随机）。
    // 结果偏向字母靠前的词条，**不是**真正的常用词分布，质量低于 --mode common。
    candidates.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const take = Math.min(limit, candidates.length);
    const lite = {};
    for (let i = 0; i < take; i++) lite[candidates[i]] = full[candidates[i]];

    const outPath = path.join(DATA_DIR, outName);
    fs.writeFileSync(outPath, JSON.stringify(lite));

    console.log(`子集词条: ${Object.keys(lite).length}`);
    console.log(`输出: ${outPath}`);
    console.log(`大小: ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB`);
    console.log('⚠️ 这是无词频信息的近似结果，明显差于 --mode common 版本。');
}

main();