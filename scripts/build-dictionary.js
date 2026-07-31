const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH = path.join(__dirname, '..', 'src', 'hiwords', 'data', 'AutoCompleteData.db');
const OUT_DIR = path.join(__dirname, '..', 'src', 'hiwords', 'data');

const args = process.argv.slice(2);
function getArg(name, fallback) {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

// --mode common: 仅柯林斯星级 / 牛津3000 标记的常用词；--mode full: 全量
const mode = getArg('--mode', 'full');
const outFile = getArg('--out', 'dictionary.json');
const isCommon = mode === 'common';

function buildDictionary(rows) {
    const dictionary = {};

    for (const row of rows) {
        const word = row.word;
        const translation = row.translation || '';
        const exchange = row.exchange || '';
        const phonetic = row.phonetic || '';

        if (!word || !translation.trim()) continue;

        const lowerWord = word.toLowerCase();
        if (dictionary[lowerWord]) continue; // keep first occurrence

        // Build aliases from exchange field, e.g. "p:profiles/d:profiled/i:profiling/3:profiles"
        const aliases = new Set();
        if (exchange) {
            exchange.split('/').forEach(part => {
                const idx = part.indexOf(':');
                if (idx > 0) {
                    const value = part.slice(idx + 1).trim();
                    if (value && value.length > 1 && value.toLowerCase() !== lowerWord) {
                        aliases.add(value.toLowerCase());
                    }
                }
            });
        }

        // Clean translation: remove empty lines and normalize
        const definitions = translation
            .split(/\n/)
            .map(t => t.trim())
            .filter(t => t.length > 0);

        if (definitions.length === 0) continue;

        dictionary[lowerWord] = {
            p: phonetic || undefined,
            d: definitions.slice(0, 5), // keep up to 5 definitions
            a: Array.from(aliases).slice(0, 10) // keep up to 10 aliases
        };
    }

    return dictionary;
}

function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`Dictionary database not found: ${DB_PATH}`);
        console.error('Please extract AutoCompleteData.zip first.');
        process.exit(1);
    }

    console.log('Querying dictionary database...');

    const where = isCommon ? 'WHERE (collins > 0 OR oxford = 1)' : '';
    const sql = `
        SELECT word, phonetic, translation, exchange
        FROM stardict
        ${where}
        ORDER BY word
    `;

    const stdout = execFileSync('sqlite3', [DB_PATH, '.mode json', sql], {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 1024 // 1GB buffer
    });

    const rows = JSON.parse(stdout);
    console.log(`Query returned ${rows.length} rows`);

    const dictionary = buildDictionary(rows);
    const uniqueCount = Object.keys(dictionary).length;
    console.log(`Unique words in dictionary: ${uniqueCount}`);

    const outPath = path.join(OUT_DIR, outFile);
    fs.writeFileSync(outPath, JSON.stringify(dictionary));
    const stats = fs.statSync(outPath);
    console.log(`Output file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

main();
