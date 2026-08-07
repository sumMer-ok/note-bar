const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(name, fallback) {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const inputPath = getArg('--input', '/tmp/legal-raw.txt');
const outPath = getArg('--out', '/tmp/legal-sample-dict.json');
const maxEntries = parseInt(getArg('--max', '0'), 10); // 0 = all

/**
 * 清理行首页码（右栏溢出的纯数字）
 */
function cleanPageNumber(line) {
    return line.replace(/^\d{1,4}\s+/, '');
}

/**
 * 合并跨行连字符（行尾 - 后接换行，合并并去掉 -）
 * 注意：保留单词内部的连字符，只合并行尾的软连字符
 */
function joinHyphenated(text) {
    // 行尾 - 后跟小写字母开头的新行 → 合并
    return text.replace(/-\n([a-z])/g, '$1');
}

/**
 * 清理软连字符 (U+00AD) 和其他排版残留
 */
function cleanTypography(text) {
    return text
        .replace(/\u00AD/g, '')        // 软连字符
        .replace(/C::;>|c::;>/g, '§')  // OCR 错误：§ 符号
        .replace(/\s+/g, ' ')          // 合并多余空格
        .trim();
}

/**
 * 判断括号内是否是音标（而非普通英文括号说明）
 * 音标特征：包含 - / ; : 等发音符号，或纯非英文
 */
function isPhonetic(text) {
    // 包含发音符号
    if (/[-;:ʼˈˌəʌθðʃʒŋ]/.test(text)) return true;
    // 纯非英文字母（如 Law Latin）
    if (!/[a-zA-Z]/.test(text)) return true;
    // 检查是否是多个完整英文单词（>3 字母的单词 ≥2 个 → 不是音标）
    const words = text.match(/[a-zA-Z]{4,}/g) || [];
    if (words.length >= 2) return false;
    // 单个短词或混合 → 可能是音标
    return true;
}

/**
 * 判断一行是否是词条头部
 * 返回 { word, rest } 或 null
 */
function tryParseHeadword(line) {
    const cleaned = cleanPageNumber(line).trim();
    if (!cleaned) return null;

    // 缩进行不是词条
    if (/^\s/.test(line)) return null;
    // 排除引用行、数字行、特殊符号开头
    if (/^[§\d\["'(]/.test(cleaned)) return null;

    // 提取词条词（1-3 个单词，避免匹配到完整句子）
    const headwordMatch = cleaned.match(/^([A-Za-z][A-Za-z\-']*(?:\s+[A-Za-z][A-Za-z\-']*){0,2}?)(?=[\s,.(])/);
    if (!headwordMatch) return null;

    let word = headwordMatch[1];
    let rest = cleaned.slice(word.length).trim();

    // 排除句子中间的行：词条词不应以常见句子词结尾
    const wordLower = word.toLowerCase();
    const sentenceWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
        'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
        'may', 'might', 'can', 'could', 'must', 'of', 'in', 'on', 'at', 'to', 'for',
        'with', 'by', 'from', 'into', 'onto', 'upon', 'this', 'that', 'these', 'those',
        'and', 'or', 'but', 'if', 'when', 'where', 'while', 'as', 'not', 'no', 'so'];
    const lastWord = wordLower.split(' ').pop();
    if (sentenceWords.includes(lastWord) && wordLower.split(' ').length > 1) return null;

    // 音标匹配：检查括号内是否真的是音标
    let isPhoneticHead = false;
    const phoneticMatch = rest.match(/^\(([^)]+)\)\s*\.?\s*/);
    if (phoneticMatch && isPhonetic(phoneticMatch[1])) {
        isPhoneticHead = true;
    }

    // 词条特征：word 后面紧跟以下任一模式才算是词条头部
    const isHeadword =
        /^,?\s*(n\.|vb\.|adj\.|adv\.|abbr\.)/.test(rest) ||  // ", n." / ", vb."
        isPhoneticHead ||                                       // "(音标)"
        /^\(\d{1,2}[a-z]?\)\s*\.?/.test(rest) ||               // "(year)" 如 (14c) (1848)
        /^\.?\s*See\s/.test(rest) ||                            // ". See xxx"
        /^\.?\s*Hist\./.test(rest) ||                           // ". Hist."
        /^\.?\s*Eccles\./.test(rest) ||                         // ". Eccles."
        /^\.?\s*Law\s/.test(rest) ||                            // ". Law Latin" / ". Law French"
        /^$/.test(rest);                                         // "word" 单独一行

    if (!isHeadword) return null;

    word = word.trim();
    return { word, rest };
}

/**
 * 提取音标、词性、年份
 */
function parseMetadata(rest) {
    let phonetic = null;
    let pos = null;
    let year = null;
    let remaining = rest;

    // 去掉开头的 .
    remaining = remaining.replace(/^\.?\s*/, '');

    // 音标：(xxx) 在最前
    const phoneticMatch = remaining.match(/^\(([^)]+)\)\s*\.?\s*/);
    if (phoneticMatch) {
        phonetic = phoneticMatch[1];
        remaining = remaining.slice(phoneticMatch[0].length);
    }

    // 词性：, n. / , vb. 等
    const posMatch = remaining.match(/^,\s*(n\.|vb\.|adj\.|adv\.|conj\.|prep\.|pron\.|int\.|art\.)\s*/);
    if (posMatch) {
        pos = posMatch[1];
        remaining = remaining.slice(posMatch[0].length);
    }

    // 年份：(1848) / (16c) / (1909)
    const yearMatch = remaining.match(/^\((\d{1,2}[a-z]?|\d{3,4})\)\s*\.?\s*/);
    if (yearMatch) {
        year = yearMatch[1];
        remaining = remaining.slice(yearMatch[0].length);
    }

    // abbr.
    const abbrMatch = remaining.match(/^abbr\.\s*/);
    if (abbrMatch) {
        pos = 'abbr.';
        remaining = remaining.slice(abbrMatch[0].length);
    }

    return { phonetic, pos, year, definition: remaining.trim() };
}

/**
 * 提取参见引用（See xxx）
 */
function extractSeeAlso(text) {
    const matches = text.match(/See\s+([A-Z][A-Za-z\s,]+?)\./g);
    return matches ? matches.map(m => m.replace(/See\s+/, '').replace(/\.$/, '').trim()) : [];
}

function main() {
    if (!fs.existsSync(inputPath)) {
        console.error(`Input not found: ${inputPath}`);
        process.exit(1);
    }

    console.log(`Reading: ${inputPath}`);
    let text = fs.readFileSync(inputPath, 'utf-8');

    // 合并跨行连字符
    text = joinHyphenated(text);

    const lines = text.split('\n');
    console.log(`Total lines: ${lines.length}`);

    const entries = {};
    let current = null; // { word, phonetic, pos, year, definitionParts: [] }
    let count = 0;

    const flushCurrent = () => {
        if (!current || !current.word) return;
        const fullDef = cleanTypography(current.definitionParts.join(' '));
        if (!fullDef) {
            current = null;
            return;
        }
        const seeAlso = extractSeeAlso(fullDef);
        const key = current.word.toLowerCase();
        if (!entries[key]) {
            entries[key] = {
                p: current.phonetic || undefined,
                pos: current.pos || undefined,
                year: current.year || undefined,
                d_en: [fullDef],
                a: [],
                seeAlso: seeAlso.length > 0 ? seeAlso : undefined,
            };
            count++;
        } else {
            // 已存在，追加释义
            entries[key].d_en.push(fullDef);
        }
        current = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headword = tryParseHeadword(line);

        if (headword) {
            flushCurrent();
            const meta = parseMetadata(headword.rest);
            current = {
                word: headword.word,
                phonetic: meta.phonetic,
                pos: meta.pos,
                year: meta.year,
                definitionParts: meta.definition ? [meta.definition] : [],
            };
            if (maxEntries > 0 && count >= maxEntries) break;
        } else if (current) {
            // 释义延续行
            const cleaned = cleanPageNumber(line).trim();
            if (cleaned) {
                current.definitionParts.push(cleaned);
            }
        }
    }
    flushCurrent();

    console.log(`Parsed ${count} unique entries`);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(entries, null, 2));
    const stats = fs.statSync(outPath);
    console.log(`Output: ${outPath} (${(stats.size / 1024).toFixed(1)} KB)`);

    // 打印前 5 个词条样本
    const keys = Object.keys(entries).slice(0, 5);
    console.log('\n--- Sample entries ---');
    for (const k of keys) {
        const e = entries[k];
        console.log(`\n${k}:`);
        console.log(`  phonetic: ${e.p || '-'}`);
        console.log(`  pos: ${e.pos || '-'}`);
        console.log(`  year: ${e.year || '-'}`);
        console.log(`  def: ${(e.d_en[0] || '').slice(0, 120)}...`);
        if (e.seeAlso) console.log(`  seeAlso: ${e.seeAlso.join(', ')}`);
    }
}

main();
